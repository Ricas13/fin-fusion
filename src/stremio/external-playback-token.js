'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const client = require('./source-client');
const operationLock = require('./operation-lock');

const DEFAULT_TTL_HOURS = 12;
const RETRY_MINUTES = 15;

function ttlHours(value = process.env.STREMIO_EXTERNAL_RAW_TOKEN_TTL_HOURS) {
  return Math.max(2, Math.min(24, Number.parseInt(value, 10) || DEFAULT_TTL_HOURS));
}

function compactError(error) {
  return String(error?.message || error || 'Unknown error').replace(/[\r\n\t\u2028\u2029]+/g, ' ').slice(0, 1000);
}

function deviceIdFor(sourceId, entitlementId) {
  const digest = crypto.createHash('sha256').update(`${String(sourceId)}:${String(entitlementId)}`, 'utf8').digest('hex').slice(0, 32);
  return `captainfin-raw-${digest}`;
}

async function entitlementActive(entitlementId, db = query) {
  const result = await db(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
      UNION ALL
      SELECT a.customer_id,a.subscription_id,a.access_expires_at,
             public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
      FROM effective_customer_addons a
      JOIN subscriptions s ON s.id=a.subscription_id
    )
    SELECT EXISTS(
      SELECT 1
      FROM stremio_entitlements e
      JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
      WHERE e.id=$1 AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
    ) AS active`, [entitlementId]);
  return result.rows[0]?.active === true;
}

async function current(sourceId, entitlementId) {
  const result = await query(`SELECT * FROM stremio_external_playback_tokens
    WHERE source_id=$1 AND entitlement_id=$2 LIMIT 1`, [sourceId, entitlementId]);
  return result.rows[0] || null;
}

async function extend(row) {
  const hours = ttlHours();
  const result = await query(`UPDATE stremio_external_playback_tokens
    SET last_issued_at=NOW(),expires_at=NOW()+($2||' hours')::interval,last_error=NULL
    WHERE id=$1 RETURNING *`, [row.id, String(hours)]);
  return result.rows[0] || row;
}

async function revokeRow(row) {
  const token = client.decryptToken(row.token_encrypted);
  const ok = await client.logoutToken(row.base_url, token, row.source_name || 'Media server', row.media_server_type || 'jellyfin');
  if (!ok) throw new Error('Media server did not confirm external playback-token logout.');
  await query('DELETE FROM stremio_external_playback_tokens WHERE id=$1', [row.id]);
  return true;
}

async function tokenFor(source, entitlement) {
  if (!source?.id || !entitlement?.id) throw new Error('External raw playback requires a source and current Stremio entitlement.');
  return operationLock.withLock(`external-playback:${source.id}:${entitlement.id}`, async () => {
    if (!await entitlementActive(entitlement.id)) {
      const error = new Error('Stremio entitlement is no longer active.');
      error.code = 'STREMIO_ENTITLEMENT_INACTIVE';
      throw error;
    }

    const existing = await current(source.id, entitlement.id);
    if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
      const refreshed = await extend(existing);
      return client.decryptToken(refreshed.token_encrypted);
    }
    if (existing) {
      // Jellyfin/Emby access tokens are server sessions rather than true TTL
      // bearer tokens. Removing our DB row is not enough: explicitly logout
      // the expired session before replacing it, otherwise an old copied raw
      // URL could remain usable directly against the external server.
      await revokeRow(existing);
    }

    if (!source.password_encrypted) {
      const error = new Error('External source must be reconnected before secure raw playback can be issued.');
      error.code = 'STREMIO_SOURCE_RECONNECT_REQUIRED';
      throw error;
    }

    const password = client.decryptPassword(source.password_encrypted);
    const auth = await client.authenticate(
      source.base_url,
      source.jellyfin_username,
      password,
      source.media_server_type || null,
      {
        deviceId: deviceIdFor(source.id, entitlement.id),
        device: 'CAPTAiNFiN Raw Stremio',
        client: 'CAPTAiNFiN Stremio'
      }
    );
    if (source.jellyfin_user_id && String(auth.jellyfinUserId) !== String(source.jellyfin_user_id)) {
      await client.logoutToken(auth.baseUrl, auth.accessToken, source.name || source.jellyfin_username || 'Media server', auth.mediaServerType).catch(() => {});
      const error = new Error('External source authentication returned a different media-server user. Reconnect this source.');
      error.code = 'STREMIO_SOURCE_IDENTITY_CHANGED';
      throw error;
    }

    try {
      if (!await entitlementActive(entitlement.id)) throw new Error('Stremio entitlement ended while external playback access was being prepared.');
      const encrypted = client.encryptToken(auth.accessToken);
      const hours = ttlHours();
      const stored = await transaction(async db => {
        const result = await db.query(`INSERT INTO stremio_external_playback_tokens(
            source_id,entitlement_id,base_url,source_name,media_server_type,token_encrypted,issued_at,last_issued_at,expires_at
          ) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW(),NOW()+($7||' hours')::interval)
          ON CONFLICT(source_id,entitlement_id) DO UPDATE SET
            base_url=EXCLUDED.base_url,
            source_name=EXCLUDED.source_name,
            media_server_type=EXCLUDED.media_server_type,
            token_encrypted=EXCLUDED.token_encrypted,
            issued_at=NOW(),
            last_issued_at=NOW(),
            expires_at=EXCLUDED.expires_at,
            last_revoke_attempt_at=NULL,
            revoke_attempt_count=0,
            last_error=NULL
          RETURNING *`, [
          source.id,
          entitlement.id,
          auth.baseUrl,
          source.name || source.jellyfin_username || null,
          auth.mediaServerType || source.media_server_type || 'jellyfin',
          encrypted,
          String(hours)
        ]);
        return result.rows[0];
      });
      return client.decryptToken(stored.token_encrypted);
    } catch (error) {
      await client.logoutToken(auth.baseUrl, auth.accessToken, source.name || source.jellyfin_username || 'Media server', auth.mediaServerType).catch(() => {});
      throw error;
    }
  });
}

async function revokeDue({ limit = 100 } = {}) {
  const rows = (await query(`SELECT t.*
    FROM stremio_external_playback_tokens t
    WHERE t.expires_at<=NOW()
       OR NOT EXISTS(
         WITH effective AS (
           SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
           UNION ALL
           SELECT a.customer_id,a.subscription_id,a.access_expires_at,
                  public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
           FROM effective_customer_addons a JOIN subscriptions s ON s.id=a.subscription_id
         )
         SELECT 1 FROM stremio_entitlements e
         JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
         WHERE e.id=t.entitlement_id AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
       )
    ORDER BY t.expires_at,t.id LIMIT $1`, [Math.max(1, Math.min(1000, Number(limit) || 100))])).rows;

  let revoked = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await revokeRow(row);
      revoked += 1;
    } catch (error) {
      failed += 1;
      await query(`UPDATE stremio_external_playback_tokens
        SET last_revoke_attempt_at=NOW(),revoke_attempt_count=revoke_attempt_count+1,last_error=$2,
            expires_at=NOW()+($3||' minutes')::interval
        WHERE id=$1`, [row.id, compactError(error), String(RETRY_MINUTES)]).catch(() => {});
      console.error(`External Stremio playback-token revocation failed for ${row.source_name || row.source_id}:`, compactError(error));
    }
  }
  return { total: rows.length, revoked, failed };
}

module.exports = { DEFAULT_TTL_HOURS, RETRY_MINUTES, ttlHours, deviceIdFor, entitlementActive, current, tokenFor, revokeRow, revokeDue };
