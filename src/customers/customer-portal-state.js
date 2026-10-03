'use strict';

const { query } = require('../db');
const customerAccessState = require('../access/customer-access-state');
const subscriptionState = require('../entitlements/subscription-state');
const referrals = require('../referrals');

function subscriptionId(row) {
  const value = row?.subscription_id || row?.id;
  return value ? String(value) : null;
}

function subscriptionsFromAccessSnapshot(snapshot = {}, addons = []) {
  const rows = [
    snapshot?.free?.entitlement,
    snapshot?.primary?.entitlement,
    snapshot?.stremio?.entitlement,
    snapshot?.emby?.entitlement,
    ...(Array.isArray(addons) ? addons : [])
  ].filter(Boolean);
  const byId = new Map();
  for (const row of rows) {
    const id = subscriptionId(row);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...row, id, subscription_id: id });
  }
  return Array.from(byId.values());
}

function currentAccessFlags(snapshot = {}, subscriptions = []) {
  const primary = Boolean(snapshot?.primary?.entitlement);
  const free = Boolean(snapshot?.free?.entitlement);
  const stremio = Boolean(snapshot?.stremio?.entitlement);
  const emby = Boolean(snapshot?.emby?.entitlement);
  const mainAccess = primary || free || stremio || emby;
  const addonServices = new Set((Array.isArray(subscriptions) ? subscriptions : [])
    .filter(subscription => subscription?.is_addon)
    .map(subscription => String(subscription?.service_type_snapshot || subscription?.service_type || 'jellyfin').toLowerCase()));
  const addonServiceAccess = ['jellyfin', 'emby', 'stremio', 'bundle'].some(service => addonServices.has(service));
  const addonJellyfinAccess = addonServices.has('jellyfin') || addonServices.has('bundle');
  return {
    hasServiceAccess: mainAccess || addonServiceAccess,
    hasRequestAccess: mainAccess,
    hasJellyfinAccess: primary || free || addonJellyfinAccess
  };
}

function hasCurrentServiceAccess(snapshot = {}, subscriptions = []) {
  return currentAccessFlags(snapshot, subscriptions).hasServiceAccess;
}

async function current(customerId, {
  includeBlocked = { primary: true, free: true, stremio: true, emby: true }
} = {}) {
  const [customerResult, accountResult, providerResult, referralSettings] = await Promise.all([
    query(`SELECT c.*,u.email AS login_email,u.username AS login_username,u.email_verified_at,u.password_changed_at
             FROM customers c
             LEFT JOIN app_users u ON u.id=c.user_id
             WHERE c.id=$1`, [customerId]),
    query(`SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url,js.location AS server_location,
                  COALESCE(js.media_server_type,'jellyfin') AS media_server_type,
                  ja.created_at<CURRENT_DATE AS can_rename_jellyfin_username
             FROM jellyfin_accounts ja
             JOIN jellyfin_servers js ON js.id=ja.server_id
             WHERE ja.customer_id=$1
               AND ja.account_purpose<>'stremio_internal'
             ORDER BY CASE COALESCE(js.media_server_type,'jellyfin') WHEN 'jellyfin' THEN 0 ELSE 1 END,
                      CASE ja.access_lane WHEN 'free' THEN 0 ELSE 1 END,
                      ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC`, [customerId]),
    query(`SELECT pc.provider,pc.provider_customer_id
             FROM payment_customers pc
             WHERE pc.customer_id=$1`, [customerId]),
    referrals.loadSettings()
  ]);

  if (!customerResult.rowCount) return null;

  const accounts = accountResult.rows;
  const jellyfinAccounts = accounts.filter(row => String(row.media_server_type || 'jellyfin').toLowerCase() === 'jellyfin');
  const [accessSnapshot, addons] = await Promise.all([
    customerAccessState.snapshot(customerId, {
      includeBlocked,
      accounts: jellyfinAccounts
    }),
    subscriptionState.effectiveAddons(customerId, {
      includeBlocked: includeBlocked?.addons ?? true
    })
  ]);

  const subscriptions = subscriptionsFromAccessSnapshot(accessSnapshot, addons);
  return {
    customer: customerResult.rows[0],
    subscriptions,
    accounts,
    providers: providerResult.rows,
    accessSnapshot,
    accessFlags: currentAccessFlags(accessSnapshot, subscriptions),
    referralCode: null,
    referralsEnabled: Boolean(referralSettings?.enabled)
  };
}

module.exports = {
  current,
  subscriptionId,
  subscriptionsFromAccessSnapshot,
  currentAccessFlags,
  hasCurrentServiceAccess
};
