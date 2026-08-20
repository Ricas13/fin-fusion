'use strict';

const { query, transaction } = require('../db');
const identity = require('./network-identity');
const { boundedInt, DEFAULT_HOUSEHOLD_NETWORK_LIMIT, DEFAULT_HOUSEHOLD_LEASE_MINUTES } = require('./drivers');

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function normalizedOptions(options = {}) {
  const tenantKey = clean(options.tenantKey || 'default', 100) || 'default';
  const scope = clean(options.scope, 80);
  const subjectKey = clean(options.subjectKey, 200);
  if (!scope || !subjectKey) throw new Error('Network lease scope and subject are required.');
  const networkLimit = boundedInt(options.networkLimit, 1, 10, DEFAULT_HOUSEHOLD_NETWORK_LIMIT);
  const leaseMinutes = boundedInt(options.leaseMinutes, 15, 1440, DEFAULT_HOUSEHOLD_LEASE_MINUTES);
  const networkHash = options.networkHash || identity.hashNetwork(options.address);
  if (!networkHash) throw new Error('A valid public network address is required for household access.');
  return {
    tenantKey,
    scope,
    subjectKey,
    customerId: options.customerId || null,
    networkLimit,
    leaseMinutes,
    networkHash,
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
  };
}

async function recordEvent(client, cfg, decision, activeNetworkCount, expiresAt) {
  const params = [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.customerId, decision, activeNetworkCount, cfg.networkLimit, expiresAt, JSON.stringify(cfg.metadata)];
  if (decision === 'denied') {
    // A denied Jellyfin session may be observed every polling cycle. Keep a
    // useful audit signal without writing the same denial every 30 seconds.
    await client.query(
      `INSERT INTO access_network_events(tenant_key,scope,subject_key,customer_id,decision,active_network_count,network_limit,lease_expires_at,detail)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM access_network_events
         WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND decision='denied'
           AND created_at>NOW()-INTERVAL '5 minutes'
       )`,
      params
    );
    return;
  }
  await client.query(
    `INSERT INTO access_network_events(tenant_key,scope,subject_key,customer_id,decision,active_network_count,network_limit,lease_expires_at,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    params
  );
}

async function claim(options = {}) {
  const cfg = normalizedOptions(options);
  return transaction(async client => {
    const lockKey = `${cfg.tenantKey}|${cfg.scope}|${cfg.subjectKey}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
    await client.query(
      `DELETE FROM access_network_leases
       WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at<=NOW()`,
      [cfg.tenantKey, cfg.scope, cfg.subjectKey]
    );
    const active = await client.query(
      `SELECT network_hash,first_seen_at,last_seen_at,expires_at
       FROM access_network_leases
       WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()
       ORDER BY first_seen_at,network_hash
       FOR UPDATE`,
      [cfg.tenantKey, cfg.scope, cfg.subjectKey]
    );
    const existing = active.rows.find(row => String(row.network_hash).trim() === cfg.networkHash);
    if (existing) {
      const refreshed = await client.query(
        `UPDATE access_network_leases
         SET customer_id=COALESCE($5,customer_id),last_seen_at=NOW(),
             expires_at=NOW()+($6::int*INTERVAL '1 minute'),metadata=$7::jsonb
         WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND network_hash=$4
         RETURNING expires_at`,
        [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.networkHash, cfg.customerId, cfg.leaseMinutes, JSON.stringify(cfg.metadata)]
      );
      const expiresAt = refreshed.rows[0]?.expires_at || existing.expires_at;
      return { allowed: true, decision: 'refreshed', activeNetworkCount: active.rowCount, networkLimit: cfg.networkLimit, expiresAt };
    }
    if (active.rowCount >= cfg.networkLimit) {
      const expiresAt = active.rows.reduce((earliest, row) => !earliest || new Date(row.expires_at) < new Date(earliest) ? row.expires_at : earliest, null);
      await recordEvent(client, cfg, 'denied', active.rowCount, expiresAt);
      return {
        allowed: false,
        decision: 'denied',
        activeNetworkCount: active.rowCount,
        networkLimit: cfg.networkLimit,
        expiresAt,
        retryAfterSeconds: expiresAt ? Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000)) : cfg.leaseMinutes * 60
      };
    }
    const inserted = await client.query(
      `INSERT INTO access_network_leases(tenant_key,scope,subject_key,customer_id,network_hash,expires_at,metadata)
       VALUES($1,$2,$3,$4,$5,NOW()+($6::int*INTERVAL '1 minute'),$7::jsonb)
       ON CONFLICT(tenant_key,scope,subject_key,network_hash) DO UPDATE SET
         customer_id=COALESCE(EXCLUDED.customer_id,access_network_leases.customer_id),
         last_seen_at=NOW(),expires_at=EXCLUDED.expires_at,metadata=EXCLUDED.metadata
       RETURNING expires_at`,
      [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.customerId, cfg.networkHash, cfg.leaseMinutes, JSON.stringify(cfg.metadata)]
    );
    const expiresAt = inserted.rows[0]?.expires_at || null;
    await recordEvent(client, cfg, 'claimed', active.rowCount + 1, expiresAt);
    return { allowed: true, decision: 'claimed', activeNetworkCount: active.rowCount + 1, networkLimit: cfg.networkLimit, expiresAt };
  });
}

async function activeForSubject({ tenantKey = 'default', scope, subjectKey }) {
  const result = await query(
    `SELECT network_hash,first_seen_at,last_seen_at,expires_at
     FROM access_network_leases
     WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()
     ORDER BY first_seen_at,network_hash`,
    [clean(tenantKey, 100) || 'default', clean(scope, 80), clean(subjectKey, 200)]
  );
  return result.rows;
}

async function releaseSubject({ tenantKey = 'default', scope, subjectKey }) {
  const result = await query(
    `DELETE FROM access_network_leases WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3`,
    [clean(tenantKey, 100) || 'default', clean(scope, 80), clean(subjectKey, 200)]
  );
  return result.rowCount;
}

async function cleanupExpired() {
  const result = await query('DELETE FROM access_network_leases WHERE expires_at<=NOW()');
  return result.rowCount;
}

module.exports = { normalizedOptions, recordEvent, claim, activeForSubject, releaseSubject, cleanupExpired };
