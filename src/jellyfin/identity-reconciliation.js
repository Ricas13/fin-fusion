'use strict';

const { query, transaction } = require('../db');
const registry = require('./registry');
const userImport = require('./user-import');
const accessState = require('../access/customer-access-state');
const provisioning = require('./resilient-provisioning');

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function asId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) throw new Error(`A valid ${label} is required.`);
  return id;
}

function remoteDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pushMatch(map, key, value) {
  const normalized = norm(key);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, []);
  const rows = map.get(normalized);
  if (!rows.some(row => row.customer_id === value.customer_id && row.reason === value.reason)) rows.push(value);
}

async function customerIndex() {
  const result = await query(`
    SELECT c.id AS customer_id,c.display_name,c.email AS customer_email,
           au.username AS portal_username,au.email AS portal_email
    FROM customers c
    LEFT JOIN app_users au ON au.id=c.user_id
    ORDER BY COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),NULLIF(au.email,''),NULLIF(c.email,''),c.id::text)
  `);
  const index = new Map();
  for (const row of result.rows) {
    for (const [reason, value] of [
      ['portal_email', row.portal_email],
      ['customer_email', row.customer_email],
      ['portal_username', row.portal_username],
      ['display_name', row.display_name]
    ]) {
      pushMatch(index, value, { ...row, reason });
    }
  }
  return { rows: result.rows, index };
}

async function managedAccounts() {
  const result = await query(`
    SELECT ja.id AS account_id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,
           ja.access_lane,ja.account_purpose,ja.is_primary,ja.disabled,
           js.name AS server_name,COALESCE(js.media_server_type,'jellyfin') AS service_type
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    ORDER BY ja.customer_id,ja.server_id,ja.created_at
  `);
  return result.rows;
}

async function recoveryIndex() {
  const result = await query(`
    SELECT customer_id,service_type,access_lane,preferred_username,last_remote_user_id,last_server_id,removal_history
    FROM customer_media_access_recovery
  `);
  const byRemote = new Map();
  const byName = new Map();
  for (const row of result.rows) {
    if (row.last_server_id && row.last_remote_user_id) {
      byRemote.set(`${row.last_server_id}:${norm(row.last_remote_user_id)}`, { ...row, reason: 'recovery_remote_id' });
    }
    if (row.last_server_id && row.preferred_username) {
      const key = `${row.last_server_id}:${norm(row.preferred_username)}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ ...row, reason: 'recovery_username' });
    }
    const history = Array.isArray(row.removal_history) ? row.removal_history : [];
    for (const item of history) {
      if (item?.serverId && item?.remoteUserId) {
        byRemote.set(`${item.serverId}:${norm(item.remoteUserId)}`, { ...row, reason: 'recovery_history_remote_id' });
      }
      if (item?.serverId && item?.username) {
        const key = `${item.serverId}:${norm(item.username)}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push({ ...row, reason: 'recovery_history_username' });
      }
    }
  }
  return { byRemote, byName };
}

function confidence(reason) {
  if (['portal_email','customer_email','portal_username','recovery_remote_id','recovery_history_remote_id'].includes(reason)) return 'strong';
  if (['recovery_username','recovery_history_username'].includes(reason)) return 'medium';
  if (reason === 'display_name') return 'weak';
  return 'unknown';
}

async function candidateAccess(customerId) {
  const [primary, free] = await Promise.all([
    accessState.primaryJellyfin(customerId, { includeBlocked: true }),
    accessState.freeJellyfin(customerId, { includeBlocked: true })
  ]);
  return {
    primary_state: primary.state,
    primary_blocked: Boolean(primary.entitlement?.blocked),
    primary_subscription_id: primary.entitlement?.subscription_id || null,
    primary_plan_code: primary.entitlement?.contract_plan_code || primary.entitlement?.code || null,
    free_state: free.state,
    free_blocked: Boolean(free.entitlement?.blocked),
    free_subscription_id: free.entitlement?.subscription_id || null
  };
}

function classificationFor({ remote, candidates, existingAccounts, access }) {
  const stremio = /^cf_stremio_[0-9a-f]{12}(?:\d{4})?$/i.test(String(remote.jellyfin_username || ''));
  if (stremio) return 'stremio_orphan';
  if (!candidates.length) return 'unmatched_orphan';
  if (candidates.length > 1) return 'ambiguous_match';
  const strong = confidence(candidates[0].match) === 'strong';
  if (!strong) return existingAccounts.length ? 'possible_duplicate' : 'possible_match';
  if (access?.primary_state === accessState.ACCESS_STATES.ACTIVE_BLOCKED) return 'access_leak';
  if (existingAccounts.some(row => row.account_purpose === 'jellyfin')) return 'possible_duplicate';
  if (access?.primary_state === accessState.ACCESS_STATES.PAID_PROVISIONING_FAILED
      || access?.primary_state === accessState.ACCESS_STATES.INCONSISTENT_UNPAID) return 'unlinked_entitled_customer';
  return 'unlinked_customer';
}

async function discover() {
  const [remoteDiscovery, customers, accounts, recovery] = await Promise.all([
    userImport.discover(),
    customerIndex(),
    managedAccounts(),
    recoveryIndex()
  ]);
  const byCustomer = new Map();
  for (const account of accounts) {
    if (!byCustomer.has(account.customer_id)) byCustomer.set(account.customer_id, []);
    byCustomer.get(account.customer_id).push(account);
  }

  const rows = [];
  for (const remote of remoteDiscovery.rows) {
    if (remote.import_status !== 'unmanaged') continue;
    const candidateMap = new Map();
    for (const candidate of customers.index.get(norm(remote.jellyfin_username)) || []) {
      candidateMap.set(candidate.customer_id, { ...candidate, match: candidate.reason });
    }
    const remoteRecovery = recovery.byRemote.get(`${remote.server_id}:${norm(remote.jellyfin_user_id)}`);
    if (remoteRecovery) {
      candidateMap.set(remoteRecovery.customer_id, {
        customer_id: remoteRecovery.customer_id,
        match: remoteRecovery.reason
      });
    }
    for (const row of recovery.byName.get(`${remote.server_id}:${norm(remote.jellyfin_username)}`) || []) {
      if (!candidateMap.has(row.customer_id)) candidateMap.set(row.customer_id, { customer_id: row.customer_id, match: row.reason });
    }
    const candidates = [...candidateMap.values()];
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const existingAccounts = candidate ? (byCustomer.get(candidate.customer_id) || []) : [];
    const access = candidate ? await candidateAccess(candidate.customer_id) : null;
    rows.push({
      ...remote,
      classification: classificationFor({ remote, candidates, existingAccounts, access }),
      candidates,
      candidate_customer: candidate?.customer_id || null,
      candidate_match: candidate?.match || null,
      candidate_confidence: candidate ? confidence(candidate.match) : null,
      candidate_access: access,
      existing_accounts: existingAccounts
    });
  }

  const counts = {};
  for (const row of rows) counts[row.classification] = Number(counts[row.classification] || 0) + 1;
  return { ...remoteDiscovery, rows, customers: customers.rows, counts };
}

async function activeSessions(serverId, userIds) {
  const wanted = new Set((Array.isArray(userIds) ? userIds : [userIds]).map(norm).filter(Boolean));
  if (!wanted.size) return [];
  const sessions = await registry.request(serverId, '/Sessions', { timeoutMs: 10000 });
  return (Array.isArray(sessions) ? sessions : []).filter(session => wanted.has(norm(session?.UserId)));
}

async function assertStillUnmanaged(serverId, remote) {
  const existing = await query(`
    SELECT id,customer_id,jellyfin_user_id,jellyfin_username,account_purpose
    FROM jellyfin_accounts
    WHERE server_id=$1
      AND (lower(jellyfin_user_id)=lower($2) OR lower(jellyfin_username)=lower($3))
    LIMIT 1
  `, [serverId, remote.jellyfin_user_id, remote.jellyfin_username]);
  if (existing.rowCount) throw new Error('This media identity is now managed by CAPTAiNFiN. Refresh before changing it.');
}

async function deleteRemoteIdentity({ serverId, jellyfinUserId, expectedName = null, actorUserId = null, reason = 'Operator removed unmanaged media identity' }) {
  const { user: remote } = await userImport.getRemoteUser(asId(serverId, 'server ID'), asId(jellyfinUserId, 'media user ID'));
  if (expectedName && norm(remote.jellyfin_username) !== norm(expectedName)) throw new Error('The remote username changed. Refresh before deleting it.');
  if (remote.administrator) throw new Error('Administrator media identities cannot be deleted from reconciliation.');
  await assertStillUnmanaged(serverId, remote);
  const sessions = await activeSessions(serverId, remote.jellyfin_user_id);
  if (sessions.length) throw new Error('This media identity has an active playback session and cannot be deleted yet.');
  await registry.request(serverId, `/Users/${encodeURIComponent(remote.jellyfin_user_id)}`, { method: 'DELETE', timeoutMs: 10000 });
  await query(`
    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'media.identity.unmanaged_deleted','jellyfin_server',$2,$3::jsonb)
  `, [actorUserId || null, serverId, JSON.stringify({
    jellyfinUserId: remote.jellyfin_user_id,
    username: remote.jellyfin_username,
    reason
  })]);
  return remote;
}

async function linkRemoteIdentity({ customerId, serverId, jellyfinUserId, actorUserId = null }) {
  const primary = await accessState.primaryJellyfin(customerId, { includeBlocked: true });
  if (primary.state === accessState.ACCESS_STATES.ACTIVE_BLOCKED) {
    throw new Error('This customer is blocked from paid Jellyfin access. Remove the rogue remote identity instead of linking it.');
  }
  if (![accessState.ACCESS_STATES.PAID_PROVISIONING_FAILED, accessState.ACCESS_STATES.INCONSISTENT_UNPAID].includes(primary.state)) {
    throw new Error('This customer is not missing its canonical primary Jellyfin account. Use identity replacement for a true duplicate.');
  }
  return userImport.linkExistingCustomer({
    customerId,
    serverId,
    jellyfinUserId,
    makePrimary: true,
    applyPolicy: true,
    actorUserId
  });
}

async function replaceManagedIdentity({ customerId, accountId, serverId, jellyfinUserId, expectedName = null, actorUserId = null }) {
  asId(customerId, 'customer ID');
  asId(accountId, 'managed account ID');
  asId(serverId, 'server ID');
  asId(jellyfinUserId, 'media user ID');

  const primary = await accessState.primaryJellyfin(customerId, { includeBlocked: true });
  if (primary.state !== accessState.ACCESS_STATES.ACTIVE_READY
      || String(primary.account?.id || '') !== String(accountId)) {
    throw new Error('Canonical replacement is only allowed for the currently ready primary Jellyfin account.');
  }

  const { user: target } = await userImport.getRemoteUser(serverId, jellyfinUserId);
  if (expectedName && norm(target.jellyfin_username) !== norm(expectedName)) {
    throw new Error('The replacement username changed. Refresh before continuing.');
  }
  if (target.administrator || target.disabled) {
    throw new Error('The replacement media identity must be an enabled non-administrator user.');
  }

  const currentResult = await query(`
    SELECT ja.*,js.name AS server_name,js.enabled AS server_enabled,js.server_class,js.public_url
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.id=$1 AND ja.customer_id=$2 AND ja.server_id=$3
      AND ja.account_purpose='jellyfin'
    LIMIT 1
  `, [accountId, customerId, serverId]);
  if (!currentResult.rowCount) {
    throw new Error('The current managed Jellyfin identity no longer matches this customer/server.');
  }
  const current = currentResult.rows[0];
  if (norm(current.jellyfin_user_id) === norm(target.jellyfin_user_id)) {
    throw new Error('That identity is already the managed identity.');
  }

  await assertStillUnmanaged(serverId, target);
  const sessions = await activeSessions(serverId, [current.jellyfin_user_id, target.jellyfin_user_id]);
  if (sessions.length) {
    throw new Error('One of these identities has an active playback session. Try again after playback stops.');
  }

  const old = {
    jellyfinUserId: current.jellyfin_user_id,
    username: current.jellyfin_username,
    lastActivityAt: current.last_activity_at || null
  };

  // Ownership moves first and is intentionally not rolled back after a remote
  // policy attempt. Once the target remote identity can be changed by
  // CAPTAiNFiN, keeping its local ownership is the fail-safe state. Rolling the
  // row back after a later, unrelated reconciliation error could turn an
  // enabled/policy-updated target into an unmanaged access leak.
  await transaction(async db => {
    await db.query(`
      UPDATE jellyfin_accounts
      SET jellyfin_user_id=$1,jellyfin_username=$2,disabled=FALSE,last_activity_at=$3,last_policy_sync=NULL,updated_at=NOW()
      WHERE id=$4 AND customer_id=$5
    `, [target.jellyfin_user_id, target.jellyfin_username, target.last_activity_at, accountId, customerId]);
    await db.query(`
      UPDATE customer_media_access_recovery
      SET preferred_username=$2,last_remote_user_id=$3,last_server_id=$4,updated_at=NOW()
      WHERE customer_id=$1 AND service_type='jellyfin' AND access_lane=$5
    `, [customerId, target.jellyfin_username, target.jellyfin_user_id, serverId, current.access_lane || 'primary']);
    await db.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'media.identity.canonical_adopted','jellyfin_account',$2,$3::jsonb)
    `, [actorUserId || null, accountId, JSON.stringify({
      customerId, serverId,
      oldJellyfinUserId: old.jellyfinUserId,
      oldUsername: old.username,
      newJellyfinUserId: target.jellyfin_user_id,
      newUsername: target.jellyfin_username
    })]);
  });

  let policyError = null;
  try {
    const profile = await provisioning.libraryPolicyForAccount(customerId, accountId);
    if (!profile.entitlement || !profile.effective) {
      throw new Error('The customer no longer has current Jellyfin access after identity adoption.');
    }
    const applied = await provisioning.applyPolicyIfChanged(profile.account, profile.effective, false);
    if (applied?.remoteMissing) {
      throw new Error('The replacement Jellyfin identity disappeared before policy verification.');
    }
  } catch (error) {
    policyError = error;
    await query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'media.identity.canonical_policy_failed','jellyfin_account',$2,$3::jsonb)
    `, [actorUserId || null, accountId, JSON.stringify({
      customerId, serverId,
      newJellyfinUserId: target.jellyfin_user_id,
      oldJellyfinUserId: old.jellyfinUserId,
      error: String(error?.message || error).slice(0, 800),
      ownershipPreserved: true
    })]).catch(() => {});
  }

  if (policyError) {
    const error = new Error(
      'The replacement identity is now owned by CAPTAiNFiN, but its Jellyfin policy could not be verified. '
      + 'The old remote identity was left untouched. Retry reconciliation before retiring it.'
    );
    error.code = 'MEDIA_IDENTITY_POLICY_RETRY_REQUIRED';
    error.cause = policyError;
    error.ownershipPreserved = true;
    throw error;
  }

  let oldRemoteDeleted = false;
  let cleanupWarning = null;
  try {
    // Re-check active playback immediately before the destructive step.
    const lateSessions = await activeSessions(serverId, old.jellyfinUserId);
    if (lateSessions.length) {
      cleanupWarning = 'Canonical identity changed, but the old remote user started playback before cleanup and was left in place.';
    } else {
      await registry.request(
        serverId,
        `/Users/${encodeURIComponent(old.jellyfinUserId)}`,
        { method: 'DELETE', timeoutMs: 10000 }
      );
      oldRemoteDeleted = true;
    }
  } catch (error) {
    cleanupWarning = `Canonical identity changed, but the old remote Jellyfin user could not be deleted automatically: ${String(error?.message || error)}`;
  }

  if (cleanupWarning) {
    await query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'media.identity.old_remote_cleanup_deferred','jellyfin_account',$2,$3::jsonb)
    `, [actorUserId || null, accountId, JSON.stringify({
      customerId, serverId,
      oldJellyfinUserId: old.jellyfinUserId,
      warning: cleanupWarning.slice(0, 900)
    })]).catch(() => {});
  } else {
    await query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'media.identity.canonical_replaced','jellyfin_account',$2,$3::jsonb)
    `, [actorUserId || null, accountId, JSON.stringify({
      customerId, serverId,
      oldJellyfinUserId: old.jellyfinUserId,
      newJellyfinUserId: target.jellyfin_user_id
    })]).catch(() => {});
  }

  // Full customer convergence is best-effort here. Identity replacement has
  // already verified the Jellyfin policy; an unrelated Discord/Stremio/Emby
  // problem must not undo or misreport the canonical Jellyfin ownership.
  let reconcileWarning = null;
  try {
    await provisioning.reconcileCustomer(customerId);
  } catch (error) {
    reconcileWarning = `Canonical Jellyfin identity is safe, but full customer reconciliation needs retry: ${String(error?.message || error)}`;
  }

  return {
    accountId,
    customerId,
    serverId,
    target,
    old,
    oldRemoteDeleted,
    cleanupWarning,
    reconcileWarning
  };
}

module.exports = {
  discover,
  deleteRemoteIdentity,
  linkRemoteIdentity,
  replaceManagedIdentity,
  activeSessions,
  classificationFor,
  confidence
};
