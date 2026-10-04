'use strict';

const { query } = require('../db');
const registry = require('../jellyfin/registry');
const managedEntitlements = require('./managed-entitlements');
const operationLock = require('./operation-lock');

const INTERNAL_USER_RE = /^cf_stremio_[0-9a-f]{12}(?:\d{4})?$/i;
const DEFAULT_GRACE_HOURS = 12;

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function managedUsernameToken(value) {
  const match = /^cf_stremio_([0-9a-f]{12})(?:\d{4})?$/i.exec(String(value || '').trim());
  return match ? String(match[1]).toLowerCase() : null;
}

function customerManagedToken(customerId) {
  return managedUsernameToken(managedEntitlements.hiddenUsername(customerId));
}

async function potentialOwnerCustomerIds(username) {
  const token = managedUsernameToken(username);
  if (!token) return [];
  const result = await query(`
    SELECT id
    FROM customers
    WHERE LEFT(REPLACE(id::text,'-',''),12)=$1
    ORDER BY id
  `, [token]);
  return result.rows.map(row => String(row.id));
}

async function withPotentialOwnerLocks(row, fn) {
  const owners = await potentialOwnerCustomerIds(row?.jellyfin_username);
  let wrapped = fn;
  for (const customerId of owners.slice().reverse()) {
    const next = wrapped;
    wrapped = () => operationLock.withLock(
      `managed-account:${customerId}:${row.server_id}`,
      next
    );
  }
  return wrapped();
}

function graceHours(value = process.env.STREMIO_ORPHAN_ACCOUNT_GRACE_HOURS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GRACE_HOURS;
  return Math.max(1, Math.min(168, Math.floor(parsed)));
}

function mostRecentRemoteActivity(user) {
  const values = [user?.LastActivityDate, user?.LastLoginDate]
    .filter(Boolean)
    .map(value => new Date(value))
    .filter(value => !Number.isNaN(value.getTime()));
  if (!values.length) return null;
  return values.sort((a, b) => b.getTime() - a.getTime())[0];
}

function recentEnough(user, hours, now = new Date()) {
  const last = mostRecentRemoteActivity(user);
  if (!last) return false;
  return now.getTime() - last.getTime() < hours * 60 * 60 * 1000;
}

async function activeEntitledCustomers() {
  const result = await query(`
    WITH effective AS (
      SELECT customer_id,access_expires_at,blocked FROM effective_stremio_entitlements
      UNION ALL
      SELECT customer_id,access_expires_at,blocked FROM effective_customer_addons
    )
    SELECT DISTINCT customer_id
    FROM effective
    WHERE blocked=FALSE AND access_expires_at>NOW()
  `);
  return result.rows;
}

async function activeEntitlementOwnsUsername(username) {
  const wanted = norm(username);
  if (!wanted || !INTERNAL_USER_RE.test(String(username || ''))) return false;
  const token = managedUsernameToken(wanted);
  if (!token) return false;
  const rows = await activeEntitledCustomers();
  return rows.some(row => customerManagedToken(row.customer_id) === token);
}

async function ownershipRows() {
  const [accounts, intents, activeCustomers] = await Promise.all([
    query(`
      SELECT id,customer_id,server_id,jellyfin_user_id,jellyfin_username,account_purpose
      FROM jellyfin_accounts
    `),
    query(`
      SELECT id,customer_id,server_id,username,remote_user_id,status,updated_at
      FROM jellyfin_account_creation_intents
    `),
    activeEntitledCustomers()
  ]);
  return {
    accounts: accounts.rows,
    intents: intents.rows,
    activeEntitledTokens: new Set(activeCustomers.map(row => customerManagedToken(row.customer_id)).filter(Boolean))
  };
}

async function inventory({ now = new Date(), hours = graceHours() } = {}) {
  const servers = (await registry.listServers({ enabledOnly: true }))
    .filter(server => String(server.media_server_type || 'jellyfin').toLowerCase() === 'jellyfin');
  const ownership = await ownershipRows();
  const rows = [];
  const failures = [];

  for (const server of servers) {
    try {
      const [users, sessions] = await Promise.all([
        registry.request(server.id, '/Users', { timeoutMs: 10000 }),
        registry.request(server.id, '/Sessions', { timeoutMs: 10000 })
      ]);
      if (!Array.isArray(users)) throw new Error('Media server did not return a valid user list.');
      if (!Array.isArray(sessions)) throw new Error('Media server did not return a valid session list.');

      const accountById = new Map(
        ownership.accounts
          .filter(row => String(row.server_id) === String(server.id))
          .map(row => [norm(row.jellyfin_user_id), row])
      );
      const accountByName = new Map(
        ownership.accounts
          .filter(row => String(row.server_id) === String(server.id))
          .map(row => [norm(row.jellyfin_username), row])
      );
      const intentById = new Map(
        ownership.intents
          .filter(row => String(row.server_id) === String(server.id) && row.remote_user_id)
          .map(row => [norm(row.remote_user_id), row])
      );
      const intentByName = new Map(
        ownership.intents
          .filter(row => String(row.server_id) === String(server.id))
          .map(row => [norm(row.username), row])
      );
      const activeUserIds = new Set(
        (Array.isArray(sessions) ? sessions : []).map(session => norm(session?.UserId)).filter(Boolean)
      );

      for (const user of users) {
        if (!user?.Id || !INTERNAL_USER_RE.test(String(user?.Name || ''))) continue;
        const id = norm(user.Id);
        const name = norm(user.Name);
        const exact = accountById.get(id) || null;
        if (exact) continue;

        const nameOwner = accountByName.get(name) || null;
        const intent = intentById.get(id) || intentByName.get(name) || null;
        const entitled = ownership.activeEntitledTokens.has(managedUsernameToken(name));
        const active = activeUserIds.has(id);
        const lastRemoteActivity = mostRecentRemoteActivity(user);
        const recent = recentEnough(user, hours, now);
        let status = 'orphan_ready';
        if (user?.Policy?.IsAdministrator) status = 'protected_admin';
        else if (nameOwner) status = 'identity_drift';
        else if (intent) status = 'provisioning_in_flight';
        else if (entitled) status = 'active_entitlement_unlinked';
        else if (active) status = 'active_session';
        else if (!lastRemoteActivity) status = 'activity_unknown';
        else if (recent) status = 'recent_activity';

        rows.push({
          server_id: server.id,
          server_name: server.name,
          media_server_type: server.media_server_type || 'jellyfin',
          jellyfin_user_id: String(user.Id),
          jellyfin_username: String(user.Name),
          status,
          last_login_at: user.LastLoginDate || null,
          last_activity_at: user.LastActivityDate || null,
          active_session: active,
          intent_id: intent?.id || null,
          managed_name_owner: nameOwner?.id || null
        });
      }
    } catch (error) {
      failures.push({ serverId: server.id, serverName: server.name, error: String(error?.message || error) });
    }
  }

  return { rows, failures, graceHours: hours };
}

async function raceCheck(row, { now = new Date(), hours = graceHours() } = {}) {
  const ownership = await query(`
    SELECT id FROM jellyfin_accounts
    WHERE server_id=$1
      AND (lower(jellyfin_user_id)=lower($2) OR lower(jellyfin_username)=lower($3))
    LIMIT 1
  `, [row.server_id, row.jellyfin_user_id, row.jellyfin_username]);
  if (ownership.rowCount) return { safe: false, reason: 'managed_now' };

  const intent = await query(`
    SELECT id FROM jellyfin_account_creation_intents
    WHERE server_id=$1
      AND (lower(username)=lower($2) OR lower(COALESCE(remote_user_id,''))=lower($3))
    LIMIT 1
  `, [row.server_id, row.jellyfin_username, row.jellyfin_user_id]);
  if (intent.rowCount) return { safe: false, reason: 'intent_now' };

  // Local mapping loss must never turn a currently-paid Stremio service user
  // into an orphan merely because the bounded managed sweep has not reached
  // that entitlement page yet.
  if (await activeEntitlementOwnsUsername(row.jellyfin_username)) {
    return { safe: false, reason: 'active_entitlement_now' };
  }

  // Re-read the remote identity immediately before the destructive action.
  // A user that was renamed, promoted to administrator or became recently
  // active after inventory must fail closed rather than be deleted.
  const users = await registry.request(row.server_id, '/Users', { timeoutMs: 10000 });
  if (!Array.isArray(users)) return { safe: false, reason: 'remote_state_unavailable' };
  const remote = users.find(user => norm(user?.Id) === norm(row.jellyfin_user_id));
  if (!remote) return { safe: false, reason: 'remote_missing_now' };
  if (norm(remote?.Name) !== norm(row.jellyfin_username) || !INTERNAL_USER_RE.test(String(remote?.Name || ''))) {
    return { safe: false, reason: 'identity_changed_now' };
  }
  if (remote?.Policy?.IsAdministrator) return { safe: false, reason: 'administrator_now' };
  if (!mostRecentRemoteActivity(remote)) return { safe: false, reason: 'activity_unknown_now' };
  if (recentEnough(remote, hours, now)) return { safe: false, reason: 'recent_activity_now' };

  const sessions = await registry.request(row.server_id, '/Sessions', { timeoutMs: 10000 });
  if (!Array.isArray(sessions)) return { safe: false, reason: 'session_state_unavailable' };
  if (sessions.some(session => norm(session?.UserId) === norm(row.jellyfin_user_id))) {
    return { safe: false, reason: 'active_now' };
  }
  return { safe: true };
}

async function remove(row, options = {}) {
  return withPotentialOwnerLocks(row, async () => {
    const check = await raceCheck(row, options);
    if (!check.safe) return { deleted: false, skipped: check.reason };
    await registry.request(
      row.server_id,
      `/Users/${encodeURIComponent(row.jellyfin_user_id)}`,
      { method: 'DELETE', timeoutMs: 10000 }
    );
    await query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('stremio.managed.orphan_remote_deleted','jellyfin_server',$1,$2::jsonb)
    `, [row.server_id, JSON.stringify({
      jellyfinUserId: row.jellyfin_user_id,
      username: row.jellyfin_username,
      serverName: row.server_name
    })]).catch(() => {});
    return { deleted: true };
  });
}

async function run({ apply = true, now = new Date(), hours = graceHours(), limit = 5 } = {}) {
  const found = await inventory({ now, hours });
  const deletionLimit = Math.max(1, Math.min(25, Number.parseInt(String(limit), 10) || 5));
  let deletionAttempts = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = Number(found.failures.length || 0);
  const errors = [];

  for (const row of found.rows) {
    if (row.status !== 'orphan_ready') {
      skipped += 1;
      continue;
    }
    if (!apply) {
      skipped += 1;
      continue;
    }
    if (deletionAttempts >= deletionLimit) {
      skipped += 1;
      continue;
    }
    deletionAttempts += 1;
    try {
      const result = await remove(row, { now, hours });
      if (result.deleted) deleted += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        serverId: row.server_id,
        jellyfinUserId: row.jellyfin_user_id,
        username: row.jellyfin_username,
        error: String(error?.message || error).slice(0, 500)
      });
    }
  }

  const attention = found.rows.filter(row => ['identity_drift','protected_admin','active_entitlement_unlinked','activity_unknown'].includes(row.status));
  const ready = found.rows.filter(row => row.status === 'orphan_ready').length;
  const remainingReady = apply ? Math.max(0, ready - deletionAttempts) : ready;
  const warningParts = [];
  if (attention.length) warningParts.push(`${attention.length} managed Stremio remote identity issue(s) require operator review`);
  if (remainingReady) warningParts.push(`${remainingReady} safe orphan remote identity(s) remain queued for a later bounded cleanup run`);
  if (failed) warningParts.push(`${failed} orphan cleanup operation(s) failed`);

  return {
    total: found.rows.length,
    processed: deleted,
    deleted,
    skipped,
    failed,
    graceHours: found.graceHours,
    deletionLimit,
    deletionAttempts,
    remainingReady,
    findings: found.rows,
    serverFailures: found.failures,
    errors,
    ...(warningParts.length ? { warning: warningParts.join('; ').slice(0, 1000) } : {})
  };
}

module.exports = {
  INTERNAL_USER_RE,
  managedUsernameToken,
  customerManagedToken,
  potentialOwnerCustomerIds,
  withPotentialOwnerLocks,
  DEFAULT_GRACE_HOURS,
  graceHours,
  mostRecentRemoteActivity,
  recentEnough,
  activeEntitledCustomers,
  activeEntitlementOwnsUsername,
  inventory,
  raceCheck,
  remove,
  run
};
