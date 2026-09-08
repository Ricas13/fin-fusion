'use strict';

const core = require('./provisioning-engine');
const durableCreation = require('./durable-account-creation');
const { query, transaction } = require('../db');
const subscriptionState = require('../entitlements/subscription-state');
const planServers = require('./plan-servers');
const placement = require('./placement');
const adminControl = require('./admin-control');
const userCapacity = require('./user-capacity');

const PLACEMENT_LEASE_MINUTES = 10;

// This module is the dependency-safe helper surface used by the canonical
// multi-service reconciler. Jellyfin customer accounts have one invariant:
// present means enabled. When access is no longer entitled, remove the account
// instead of representing access loss as a disabled Jellyfin user.
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
  usernameAvailable,
  markPrimaryAccount,
  renameJellyfinAccount
} = core;

function policyBody(effectiveTechnical, disabledOrLibraryAccess, maybeLibraryAccess) {
  const libraryAccess = maybeLibraryAccess || disabledOrLibraryAccess;
  return core.policyBody(effectiveTechnical, false, libraryAccess);
}

function resolveLibraryAccessForServer(serverId, unrestricted, visibleNames) {
  return core.resolveLibraryAccessForServer(serverId, unrestricted, visibleNames, false);
}

async function applyPolicy(account, effective) {
  return core.applyPolicy(account, effective, false);
}

async function deleteJellyfinAccount(account, options = {}) {
  const result = await core.deleteJellyfinAccount(account, options);
  if (result?.disabledInstead) {
    const error = new Error('Jellyfin account deletion fell back to a disabled state, which is forbidden.');
    error.code = 'JELLYFIN_DISABLED_STATE_FORBIDDEN';
    throw error;
  }
  return result;
}

// Compatibility name retained while callers are migrated. Its semantics are
// deliberately delete, never disable. This makes every legacy suspension path
// converge on the binary account-presence invariant.
async function disableJellyfinAccount(account, options = {}) {
  return deleteJellyfinAccount(account, {
    ...options,
    reason: options.reason || 'Jellyfin entitlement no longer grants access'
  });
}

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

function requestedAccessLane(plan) {
  return plan?.is_free_tier === true || String(plan?.server_class || '') === 'free' && Number(plan?.price_minor ?? plan?.contract_price_minor ?? 0) === 0
    ? 'free'
    : 'primary';
}

async function selectServerForPlan(plan) {
  // An explicit admin pin is an imperative command, not a placement hint.
  // Return the exact configured Jellyfin target before evaluating public
  // capacity, plan mappings, allow_new_users, health ranking or pool priority.
  const lane = requestedAccessLane(plan);
  const forced = await adminControl.forcedServerForPlan(plan);
  if (forced) return { ...forced, placement_forced: true, requested_access_lane: lane };

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

  // Server capacity includes durable accounts plus short-lived placement leases
  // and creation intents. A concurrent reconciler therefore sees a slot as used
  // before the corresponding remote Jellyfin account exists.
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
  const selected = placement.selectServer(candidates, plan?.placement_strategy);
  return selected ? { ...selected, requested_access_lane: lane } : null;
}

async function reservePlacement(customerId, server) {
  if (!customerId || !server?.id) throw new Error('Customer and Jellyfin server are required for placement reservation.');
  return transaction(async db => {
    const locked = await db.query(`SELECT id,max_users FROM jellyfin_servers WHERE id=$1 FOR UPDATE`, [server.id]);
    if (!locked.rowCount) throw new Error('Selected Jellyfin server no longer exists.');
    await db.query(`DELETE FROM jellyfin_server_placement_leases WHERE server_id=$1 AND expires_at<=NOW()`, [server.id]);

    const existing = await db.query(`SELECT id FROM jellyfin_server_placement_leases
      WHERE customer_id=$1 AND server_id=$2 AND expires_at>NOW() LIMIT 1`, [customerId, server.id]);
    if (existing.rowCount) {
      const renewed = await db.query(`UPDATE jellyfin_server_placement_leases
        SET expires_at=NOW()+($2||' minutes')::interval,updated_at=NOW()
        WHERE id=$1 RETURNING id`, [existing.rows[0].id, String(PLACEMENT_LEASE_MINUTES)]);
      return { ...server, placement_lease_id: renewed.rows[0].id };
    }

    if (server.placement_forced !== true) {
      const ownCapacity = await db.query(`SELECT EXISTS(
        SELECT 1 FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND disabled=FALSE AND account_purpose='jellyfin'
        UNION ALL
        SELECT 1 FROM jellyfin_account_creation_intents WHERE customer_id=$1 AND server_id=$2
      ) yes`, [customerId, server.id]);
      if (ownCapacity.rows[0]?.yes !== true) {
        const counts = await userCapacity.countsForServers([server.id], (sql, params) => db.query(sql, params));
        const used = Number(counts.get(String(server.id)) || 0);
        const maxUsers = Number(locked.rows[0].max_users || 0);
        if (maxUsers > 0 && used >= maxUsers) {
          const error = new Error('Selected Jellyfin server became full before account creation. Provisioning will retry on another available server.');
          error.code = 'JELLYFIN_SERVER_CAPACITY_CHANGED';
          throw error;
        }
      }
    }

    const lease = await db.query(`INSERT INTO jellyfin_server_placement_leases(customer_id,server_id,expires_at)
      VALUES($1,$2,NOW()+($3||' minutes')::interval)
      ON CONFLICT(customer_id,server_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,updated_at=NOW()
      RETURNING id`, [customerId, server.id, String(PLACEMENT_LEASE_MINUTES)]);
    return { ...server, placement_lease_id: lease.rows[0].id };
  });
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
             u.username portal_username,u.role user_role,c.registration_source
      FROM customers c
      LEFT JOIN app_users u ON u.id=c.user_id
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
  const reservedServer = await reservePlacement(customerId, server);
  const account = await durableCreation.createJellyfinAccount(customerId, reservedServer, effective, {
    ...options,
    placementLeaseId: reservedServer.placement_lease_id,
    accessLane: options.accessLane || reservedServer.requested_access_lane || requestedAccessLane(effective)
  });
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
  PLACEMENT_LEASE_MINUTES,
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
  deleteJellyfinAccount,
  markPrimaryAccount,
  renameJellyfinAccount,
  currentEntitlement,
  requestedAccessLane,
  selectServerForPlan,
  reservePlacement,
  notifyNewJellyfinAccess,
  createJellyfinAccount,
  setJellyfinPassword
};