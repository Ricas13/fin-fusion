'use strict';

const { query, transaction } = require('../db');
const identity = require('./network-identity');
const { boundedInt, DEFAULT_HOUSEHOLD_NETWORK_LIMIT, DEFAULT_HOUSEHOLD_LEASE_MINUTES } = require('./drivers');

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function normalizeFamily(value) {
  const family = clean(value, 10).toLowerCase();
  return family === 'ipv4' || family === 'ipv6' ? family : 'unknown';
}

function sameFamily(row, cfg) {
  const family = normalizeFamily(row.network_family);
  return family === 'unknown' || cfg.networkFamily === 'unknown' || family === cfg.networkFamily;
}

function normalizedOptions(options = {}) {
  const tenantKey = clean(options.tenantKey || 'default', 100) || 'default';
  const scope = clean(options.scope, 80);
  const subjectKey = clean(options.subjectKey, 200);
  if (!scope || !subjectKey) throw new Error('Network lease scope and subject are required.');
  const networkLimit = boundedInt(options.networkLimit, 1, 10, DEFAULT_HOUSEHOLD_NETWORK_LIMIT);
  const leaseMinutes = boundedInt(options.leaseMinutes, 15, 1440, DEFAULT_HOUSEHOLD_LEASE_MINUTES);
  const descriptor = identity.networkDescriptor(options.address);
  const networkHash = options.networkHash || (descriptor ? identity.hashNetwork(options.address) : null);
  if (!networkHash) throw new Error('A valid public network address is required for household access.');
  const networkFamily = normalizeFamily(options.networkFamily || descriptor?.family);
  return {
    tenantKey,
    scope,
    subjectKey,
    customerId: options.customerId || null,
    networkLimit,
    leaseMinutes,
    networkHash,
    networkFamily,
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {}
  };
}

async function recordEvent(client, cfg, decision, activeNetworkCount, expiresAt) {
  const params = [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.customerId, cfg.networkFamily, decision, activeNetworkCount, cfg.networkLimit, expiresAt, JSON.stringify(cfg.metadata)];
  if (decision === 'denied') {
    await client.query(
      `INSERT INTO access_network_events(tenant_key,scope,subject_key,customer_id,network_family,decision,active_network_count,network_limit,lease_expires_at,detail)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM access_network_events
         WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND COALESCE(network_family,'unknown')=$5 AND decision='denied'
           AND created_at>NOW()-INTERVAL '5 minutes'
       )`,
      params
    );
    return;
  }
  await client.query(
    `INSERT INTO access_network_events(tenant_key,scope,subject_key,customer_id,network_family,decision,active_network_count,network_limit,lease_expires_at,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    params
  );
}

async function claim(options = {}) {
  const cfg = normalizedOptions(options);
  return transaction(async client => {
    const lockKey = `${cfg.tenantKey}|${cfg.scope}|${cfg.subjectKey}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
    const active = await client.query(
      `SELECT network_hash,network_family,first_seen_at,last_seen_at,expires_at
       FROM access_network_leases
       WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()
       ORDER BY first_seen_at,network_hash
       FOR UPDATE`,
      [cfg.tenantKey, cfg.scope, cfg.subjectKey]
    );
    const existing = active.rows.find(row => String(row.network_hash).trim() === cfg.networkHash);
    const activeSameFamily = active.rows.filter(row => sameFamily(row, cfg));
    if (existing) {
      const refreshed = await client.query(
        `UPDATE access_network_leases
         SET customer_id=COALESCE($5,customer_id),last_seen_at=NOW(),
             expires_at=NOW()+($6::int*INTERVAL '1 minute'),
             network_family=CASE WHEN network_family IS NULL OR network_family='unknown' THEN $7 ELSE network_family END,
             metadata=$8::jsonb
         WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND network_hash=$4
         RETURNING expires_at`,
        [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.networkHash, cfg.customerId, cfg.leaseMinutes, cfg.networkFamily, JSON.stringify(cfg.metadata)]
      );
      const expiresAt = refreshed.rows[0]?.expires_at || existing.expires_at;
      return { allowed: true, decision: 'refreshed', activeNetworkCount: Math.max(1, activeSameFamily.length), networkLimit: cfg.networkLimit, networkFamily: cfg.networkFamily, expiresAt };
    }
    if (activeSameFamily.length >= cfg.networkLimit) {
      const expiresAt = activeSameFamily.reduce((earliest, row) => !earliest || new Date(row.expires_at) < new Date(earliest) ? row.expires_at : earliest, null);
      await recordEvent(client, cfg, 'denied', activeSameFamily.length, expiresAt);
      return {
        allowed: false,
        decision: 'denied',
        activeNetworkCount: activeSameFamily.length,
        networkLimit: cfg.networkLimit,
        networkFamily: cfg.networkFamily,
        expiresAt,
        retryAfterSeconds: expiresAt ? Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000)) : cfg.leaseMinutes * 60
      };
    }
    const inserted = await client.query(
      `INSERT INTO access_network_leases(tenant_key,scope,subject_key,customer_id,network_hash,network_family,expires_at,metadata)
       VALUES($1,$2,$3,$4,$5,$6,NOW()+($7::int*INTERVAL '1 minute'),$8::jsonb)
       ON CONFLICT(tenant_key,scope,subject_key,network_hash) DO UPDATE SET
         customer_id=COALESCE(EXCLUDED.customer_id,access_network_leases.customer_id),
         network_family=EXCLUDED.network_family,
         last_seen_at=NOW(),expires_at=EXCLUDED.expires_at,metadata=EXCLUDED.metadata
       RETURNING expires_at`,
      [cfg.tenantKey, cfg.scope, cfg.subjectKey, cfg.customerId, cfg.networkHash, cfg.networkFamily, cfg.leaseMinutes, JSON.stringify(cfg.metadata)]
    );
    const expiresAt = inserted.rows[0]?.expires_at || null;
    await recordEvent(client, cfg, 'claimed', activeSameFamily.length + 1, expiresAt);
    return { allowed: true, decision: 'claimed', activeNetworkCount: activeSameFamily.length + 1, networkLimit: cfg.networkLimit, networkFamily: cfg.networkFamily, expiresAt };
  });
}

async function preview(options = {}) {
  const cfg = normalizedOptions(options);
  const active = await query(
    `SELECT network_hash,network_family,first_seen_at,last_seen_at,expires_at
     FROM access_network_leases
     WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()
     ORDER BY first_seen_at,network_hash`,
    [cfg.tenantKey, cfg.scope, cfg.subjectKey]
  );
  const existing = active.rows.find(row => String(row.network_hash).trim() === cfg.networkHash);
  const activeSameFamily = active.rows.filter(row => sameFamily(row, cfg));
  if (existing) return { allowed: true, decision: 'refreshed', activeNetworkCount: Math.max(1, activeSameFamily.length), networkLimit: cfg.networkLimit, networkFamily: cfg.networkFamily, expiresAt: existing.expires_at };
  if (activeSameFamily.length >= cfg.networkLimit) {
    const expiresAt = activeSameFamily.reduce((earliest, row) => !earliest || new Date(row.expires_at) < new Date(earliest) ? row.expires_at : earliest, null);
    return {
      allowed: false,
      decision: 'denied',
      activeNetworkCount: activeSameFamily.length,
      networkLimit: cfg.networkLimit,
      networkFamily: cfg.networkFamily,
      expiresAt,
      retryAfterSeconds: expiresAt ? Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000)) : cfg.leaseMinutes * 60
    };
  }
  return { allowed: true, decision: 'available', activeNetworkCount: activeSameFamily.length, networkLimit: cfg.networkLimit, networkFamily: cfg.networkFamily, expiresAt: null };
}

async function activeForSubject({ tenantKey = 'default', scope, subjectKey }, { client = null } = {}) {
  const db = client || { query };
  const result = await db.query(
    `SELECT network_hash,network_family,first_seen_at,last_seen_at,expires_at
     FROM access_network_leases
     WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()
     ORDER BY first_seen_at,network_hash`,
    [clean(tenantKey, 100) || 'default', clean(scope, 80), clean(subjectKey, 200)]
  );
  return result.rows;
}

async function releaseSubject({ tenantKey = 'default', scope, subjectKey }, { client = null } = {}) {
  const db = client || { query };
  const result = await db.query(
    `UPDATE access_network_leases SET expires_at=NOW()
     WHERE tenant_key=$1 AND scope=$2 AND subject_key=$3 AND expires_at>NOW()`,
    [clean(tenantKey, 100) || 'default', clean(scope, 80), clean(subjectKey, 200)]
  );
  return result.rowCount;
}

async function cleanupExpired() {
  const result = await query('DELETE FROM access_network_leases WHERE expires_at<=NOW()');
  return result.rowCount;
}

module.exports = { normalizedOptions, recordEvent, claim, preview, activeForSubject, releaseSubject, cleanupExpired };
