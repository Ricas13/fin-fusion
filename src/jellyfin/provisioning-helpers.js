'use strict';

const core = require('./provisioning-engine');
const durableCreation = require('./durable-account-creation');
const { query } = require('../db');
const subscriptionState = require('../entitlements/subscription-state');
const planServers = require('./plan-servers');
const placement = require('./placement');
const adminControl = require('./admin-control');
const userCapacity = require('./user-capacity');

// This module is the dependency-safe helper surface used by the canonical
// multi-service reconciler. It intentionally exposes only low-level account,
// policy and override primitives. Customer reconciliation, access holds and
// subscription expiry are owned elsewhere and must never be re-exported from
// the legacy single-lane provisioning engine.
const {
  discoverServerLibraries,
  libraryCatalogForServerClass,
  libraryCatalogForPlan,
  upsertReconciliationStatus,
  getPolicyOverride,
  setPolicyOverrideField,
  resetPolicyOverrideField,
  resetAllPolicyOverrides,
  getLibraryOverrides,
  setLibraryOverride,
  resetLibraryOverride,
  resetAllLibraryOverrides,
  getLibrarySelection,
  setLibrarySelection,
  effectivePolicyForCustomer,
  policyBody,
  resolveLibraryAccessForServer,
  usernameAvailable,
  applyPolicy,
  disableJellyfinAccount,
  markPrimaryAccount,
  renameJellyfinAccount
} = core;

function safeLog(value, max = 500) {
  return String(value == null ? '' : value).replace(/[\r\n\t\u2028\u2029]+/g, ' ').slice(0, max);
}

async function currentEntitlement(customerId) {
  return subscriptionState.effectiveSubscription(customerId);
}

async function markPasswordSetupRequired(accountId) {
  if (!accountId) return;
  await query(`
    UPDATE jellyfin_accounts
    SET password_setup_required=TRUE,password_reset_required=TRUE,updated_at=NOW()
    WHERE id=$1
  `, [accountId]);
}

async function selectServerForPlan(plan) {
  // An explicit admin pin is an imperative command, not a placement hint.
  // Return the exact configured Jellyfin target before evaluating public
  // capacity, plan mappings, allow_new_users, health ranking or pool priority.
  const forced = await adminControl.forcedServerForPlan(plan);
  if (forced) return forced;

  const accessKind = String(plan?.billing_interval || plan?.contract_billing_interval || '') === 'trial'
    ? 'trial'
    : Number(plan?.price_minor ?? plan?.contract_price_minor ?? 0) === 0
      ? 'free'
      : 'paid';
  const available = (await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true }))
    .filter(server => Boolean(server.allow_new_users))
    .filter(server => accessKind === 'trial'
      ? Boolean(server.trial_enabled)
      : accessKind === 'paid'
        ? Boolean(server.paid_enabled)
        : true);
  if (!available.length) return null;

  // Server capacity has one meaning everywhere: enabled managed customer users.
  // Every plan consumes exactly one user place regardless of its stream limit.
  const candidates = await userCapacity.decorateServers(available);
  const ids = candidates.map(server => server.id);
  const playback = await query(`
    SELECT server_id,COUNT(DISTINCT jellyfin_session_id)::int AS active_streams
    FROM active_playback_sessions
    WHERE server_id=ANY($1::uuid[])
    GROUP BY server_id
  `, [ids]);
  const streams = new Map(playback.rows.map(row => [String(row.server_id), Number(row.active_streams || 0)]));
  for (const server of candidates) server.active_streams = streams.get(String(server.id)) || 0;
  return placement.selectServer(candidates, plan?.placement_strategy);
}

async function notifyNewJellyfinAccess(customerId, account) {
  try {
    const notifications = require('../integrations/notification-dispatch');
    const runtimeSettings = require('../platform/runtime-settings');
    try {
      await runtimeSettings.ensureLoaded();
    } catch (settingsError) {
      console.warn('Runtime settings refresh failed before Jellyfin onboarding notification.', {
        customerId: safeLog(customerId, 100),
        error: safeLog(settingsError?.message || settingsError)
      });
    }
    const found = await query(`
      SELECT COALESCE(c.email,u.email) email,
             COALESCE(c.display_name,u.username,'Customer') customer_name,
             u.username portal_username,u.role user_role,c.registration_source,
             cp.phone_e164,cp.whatsapp_opt_in
      FROM customers c
      LEFT JOIN app_users u ON u.id=c.user_id
      LEFT JOIN customer_communication_preferences cp ON cp.customer_id=c.id
      WHERE c.id=$1
    `, [customerId]);
    if (!found.rowCount) return;

    const row = found.rows[0];
    const site = runtimeSettings.siteName();
    const serverUrl = String(account.public_url || '').trim();
    const username = row.portal_username || account.jellyfin_username || 'your Jellyfin username';
    const personalAdmin = row.user_role === 'admin' && row.registration_source === 'admin_personal';
    const passwordStep = account.password_setup_required
      ? personalAdmin
        ? `Set your Jellyfin password under Settings > My Profile in ${site} administration, then use that password in Jellyfin.`
        : `Sign in to your ${site} portal, open Jellyfin access and choose your Jellyfin password, then use that password in Jellyfin.`
      : personalAdmin
        ? `Use the Jellyfin password you set under Settings > My Profile in ${site} administration.`
        : `Use the password you set under Jellyfin access in your ${site} portal.`;
    const serverStep = serverUrl || `Open your ${site} portal to see the assigned Jellyfin server URL.`;
    const steps = `Your Jellyfin access has been created.\n\n1. Download an official Jellyfin client: https://jellyfin.org/downloads/\n2. Server URL: ${serverStep}\n3. Username: ${username}\n4. Password: ${passwordStep}\n\nThese same steps are shown in your ${site} account.`;
    await notifications.dispatch({
      eventType: 'customer.service.provisioned',
      to: row.email || null,
      customerId,
      subject: `Your ${site} Jellyfin access is ready`,
      text: steps,
      adminSubject: `${site}: Jellyfin access provisioned`,
      adminText: `${row.customer_name} (${row.email || customerId}) was provisioned as ${account.jellyfin_username || username}${serverUrl ? ` on ${serverUrl}` : ''}.`,
      whatsappTo: row.whatsapp_opt_in ? row.phone_e164 : null,
      dedupeKey: `jellyfin-provisioned:${account.id}`,
      forceEmail: true
    });
  } catch (error) {
    console.warn('Jellyfin onboarding notification failed.', {
      customerId: safeLog(customerId, 100),
      error: safeLog(error?.message || error)
    });
  }
}

async function createJellyfinAccount(customerId, server, effective, options = {}) {
  const account = await durableCreation.createJellyfinAccount(customerId, server, effective, options);
  if (options.passwordSetupRequired !== false) {
    await markPasswordSetupRequired(account.id);
    account.password_setup_required = true;
    account.password_reset_required = true;
  }
  return account;
}

async function setJellyfinPassword(customerId, accountId, newPassword) {
  const result = await core.setJellyfinPassword(customerId, accountId, newPassword);
  await query(`
    UPDATE jellyfin_accounts
    SET password_setup_required=FALSE,password_reset_required=FALSE,updated_at=NOW()
    WHERE id=$1 AND customer_id=$2
  `, [accountId, customerId]);
  return result;
}

module.exports = {
  discoverServerLibraries,
  libraryCatalogForServerClass,
  libraryCatalogForPlan,
  upsertReconciliationStatus,
  getPolicyOverride,
  setPolicyOverrideField,
  resetPolicyOverrideField,
  resetAllPolicyOverrides,
  getLibraryOverrides,
  setLibraryOverride,
  resetLibraryOverride,
  resetAllLibraryOverrides,
  getLibrarySelection,
  setLibrarySelection,
  effectivePolicyForCustomer,
  policyBody,
  resolveLibraryAccessForServer,
  usernameAvailable,
  applyPolicy,
  disableJellyfinAccount,
  markPrimaryAccount,
  renameJellyfinAccount,
  currentEntitlement,
  selectServerForPlan,
  notifyNewJellyfinAccess,
  createJellyfinAccount,
  setJellyfinPassword
};