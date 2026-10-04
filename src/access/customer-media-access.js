'use strict';

const { query } = require('../db');
const customerAccessState = require('./customer-access-state');

function mediaType(account) {
  return String(account?.media_server_type || 'jellyfin').toLowerCase() === 'emby'
    ? 'emby'
    : 'jellyfin';
}

async function mediaRows(customerId) {
  const result = await query(`
    SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url,js.location AS server_location,
           COALESCE(js.media_server_type,'jellyfin') AS media_server_type
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1 AND ja.account_purpose<>'stremio_internal'
    ORDER BY CASE COALESCE(js.media_server_type,'jellyfin') WHEN 'jellyfin' THEN 0 ELSE 1 END,
             CASE ja.access_lane WHEN 'free' THEN 0 ELSE 1 END,
             ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC
  `, [customerId]);
  return result.rows;
}

async function accessContext(customerId, { accounts = null, accessSnapshot = null } = {}) {
  const suppliedAccounts = Array.isArray(accounts) ? accounts : null;
  const [accountRows, snapshot] = await Promise.all([
    suppliedAccounts ? Promise.resolve(suppliedAccounts) : mediaRows(customerId),
    accessSnapshot ? Promise.resolve(accessSnapshot) : customerAccessState.snapshot(customerId, {
      accounts: suppliedAccounts
        ? suppliedAccounts.filter(row => mediaType(row) === 'jellyfin')
        : null
    }).catch(() => null)
  ]);
  return {
    customerId,
    accounts: accountRows,
    accessSnapshot: snapshot,
    embyEntitlement: snapshot?.emby?.entitlement || null
  };
}

function entitlementForAccountFromContext(account, context = {}) {
  if (!account) return null;
  if (mediaType(account) === 'emby') {
    const entitlement = context.accessSnapshot?.emby?.entitlement || context.embyEntitlement || null;
    if (!entitlement) return null;
    const assignedServerId = String(entitlement.media_server_id || '').trim();
    if (assignedServerId) return String(account.server_id || '') === assignedServerId ? entitlement : null;

    // Rolling/legacy rows can predate persisted assignment. Only infer the
    // account when there is exactly one enabled Emby candidate; multiple
    // historical accounts are ambiguous and credential management must fail
    // closed until the subscription is repaired/pinned.
    const embyAccounts = (context.accounts || [])
      .filter(row => mediaType(row) === 'emby' && !row.disabled && row.server_enabled);
    return embyAccounts.length === 1 && String(embyAccounts[0].id) === String(account.id)
      ? entitlement
      : null;
  }
  const access = context.accessSnapshot || null;
  const lane = String(account.access_lane || 'primary') === 'free' ? 'free' : 'primary';
  const entitlement = lane === 'free' ? access?.free?.entitlement || null : access?.primary?.entitlement || null;
  if (!entitlement || !customerAccessState.accountMatchesEntitlement(account, entitlement, lane)) return null;

  // A persisted server assignment is authoritative. For legacy rows without
  // one, only expose credential controls when exactly one account in the lane
  // can satisfy the entitlement; otherwise an old same-class account could be
  // mistaken for the current one.
  if (entitlement.media_server_id || entitlement.admin_forced_server_id || !Array.isArray(context.accounts)) {
    return entitlement;
  }
  const candidates = context.accounts.filter(row =>
    mediaType(row) === 'jellyfin' &&
    customerAccessState.accountMatchesEntitlement(row, entitlement, lane)
  );
  return candidates.length === 1 && String(candidates[0].id) === String(account.id)
    ? entitlement
    : null;
}

async function entitlementForAccount(customerId, account, { accessSnapshot = null, embyEntitlement } = {}) {
  if (!account) return null;
  const [access, accounts] = await Promise.all([
    accessSnapshot ? Promise.resolve(accessSnapshot) : customerAccessState.snapshot(customerId).catch(() => null),
    mediaRows(customerId)
  ]);
  return entitlementForAccountFromContext(account, { accessSnapshot: access, embyEntitlement, accounts });
}

function evaluateCredentialAccess(account, entitlement) {
  if (!account) {
    return { ok: false, reason: 'not_found', account: null, entitlement: null };
  }
  if (account.disabled || !account.server_enabled) {
    return { ok: false, reason: 'account_unavailable', account, entitlement: entitlement || null };
  }
  if (!entitlement || entitlement.blocked) {
    return { ok: false, reason: 'entitlement_unavailable', account, entitlement: entitlement || null };
  }
  return { ok: true, reason: null, account, entitlement };
}

async function credentialAccess(customerId, accountId) {
  const context = await accessContext(customerId);
  const account = context.accounts.find(row => String(row.id) === String(accountId)) || null;
  const entitlement = entitlementForAccountFromContext(account, context);
  return evaluateCredentialAccess(account, entitlement);
}

function incompleteFreeSubscriptionIdFromState(access) {
  const entitlement = access?.entitlement || null;
  if (!entitlement || entitlement.blocked) return null;
  if (access?.state === customerAccessState.ACCESS_STATES.ACTIVE_READY) return null;
  return entitlement.subscription_id ? String(entitlement.subscription_id) : null;
}

async function incompleteFreeSubscriptionId(customerId) {
  const access = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  return incompleteFreeSubscriptionIdFromState(access);
}

module.exports = {
  mediaType,
  mediaRows,
  accessContext,
  entitlementForAccountFromContext,
  entitlementForAccount,
  evaluateCredentialAccess,
  credentialAccess,
  incompleteFreeSubscriptionIdFromState,
  incompleteFreeSubscriptionId
};
