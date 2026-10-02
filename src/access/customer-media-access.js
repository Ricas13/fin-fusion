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
    SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url,
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
  if (mediaType(account) === 'emby') return context.accessSnapshot?.emby?.entitlement || context.embyEntitlement || null;
  const access = context.accessSnapshot || null;
  if (String(account.access_lane || 'primary') === 'free') {
    return access?.free?.entitlement || null;
  }
  return access?.primary?.entitlement || null;
}

async function entitlementForAccount(customerId, account, { accessSnapshot = null, embyEntitlement } = {}) {
  if (!account) return null;
  const access = accessSnapshot || await customerAccessState.snapshot(customerId).catch(() => null);
  return entitlementForAccountFromContext(account, { accessSnapshot: access, embyEntitlement });
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
