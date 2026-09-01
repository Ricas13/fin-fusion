'use strict';

const { query, transaction } = require('../db');
const registry = require('./registry');
const activity = require('./activity');
const mediaPlanPolicy = require('./media-plan-policy-settings');

const DEVICE_REGISTERED_REASON = 'media_device_registered';
const DEVICE_ALLOWLIST_REASON = 'media_device_allowlist_applied';
const DEVICE_ALLOWLIST_ERROR_REASON = 'media_device_allowlist_failed';
const DEVICE_RESET_REASON = 'media_device_slots_reset';
const SESSION_WINDOW_SECONDS = 300;

function lane(value) { return String(value || '') === 'free' ? 'free' : 'primary'; }
function clean(value, max = 300) { return String(value || '').trim().slice(0, max) || null; }
function safeDeviceId(value) { return clean(value, 512); }
function sameId(a, b) { return String(a || '') === String(b || ''); }
function lastActivityMs(session) {
  const value = new Date(session?.LastActivityDate || session?.LastPlaybackCheckIn || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

async function accountsForDevicePolicy(customerId = null) {
  const params = [];
  const customerWhere = customerId ? `AND ja.customer_id=$${params.push(customerId)}` : '';
  const result = await query(`
    SELECT ja.id AS account_id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,
           ja.access_lane,js.name AS server_name,COALESCE(js.media_server_type,'jellyfin') AS media_server_type,
           entitlement.subscription_id,entitlement.plan_id,
           mdp.managed AS device_policy_managed,mdp.enforced AS device_policy_enforced,
           mdp.subscription_id AS stored_subscription_id,
           mdp.device_limit AS stored_device_limit,mdp.last_applied_devices,mdp.last_applied_at,
           mdp.last_error,mdp.reset_at
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN LATERAL (
      SELECT s.id AS subscription_id,s.plan_id,
             CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                  THEN 'infinity'::timestamptz
                  ELSE s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval)
             END AS access_expires_at,
             s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
      WHERE s.customer_id=ja.customer_id
        AND (CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END)=CASE WHEN ja.access_lane='free' THEN 'free' ELSE 'primary' END
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND (
          (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
          OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
          OR (COALESCE(s.service_extension_days,0)>0
              AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
              AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
        )
      ORDER BY access_expires_at DESC,s.created_at DESC
      LIMIT 1
    ) entitlement ON TRUE
    LEFT JOIN media_account_device_policy mdp ON mdp.jellyfin_account_id=ja.id
    JOIN customers c ON c.id=ja.customer_id AND c.access_paused_at IS NULL
    WHERE ja.account_purpose='jellyfin' AND ja.disabled=FALSE AND js.enabled=TRUE
      ${customerWhere}
    ORDER BY js.priority,js.name,ja.created_at,ja.id
  `, params);
  return result.rows;
}

async function activeDevices(subscriptionId, client = null) {
  if (!subscriptionId) return [];
  const runner = client || { query };
  const result = await runner.query(`
    SELECT id,jellyfin_account_id,subscription_id,device_id,device_name,client_name,registered_at,last_seen_at,revoked_at
    FROM media_account_devices
    WHERE subscription_id=$1 AND revoked_at IS NULL
    ORDER BY registered_at,device_id
  `, [subscriptionId]);
  return result.rows;
}

async function allDevices(accountId, subscriptionId = null) {
  if (subscriptionId) {
    const result = await query(`
      SELECT id,jellyfin_account_id,subscription_id,device_id,device_name,client_name,registered_at,last_seen_at,revoked_at
      FROM media_account_devices
      WHERE subscription_id=$1
      ORDER BY COALESCE(revoked_at,'infinity'::timestamptz),registered_at,device_id
    `, [subscriptionId]);
    return result.rows;
  }
  const result = await query(`
    SELECT id,jellyfin_account_id,subscription_id,device_id,device_name,client_name,registered_at,last_seen_at,revoked_at
    FROM media_account_devices
    WHERE jellyfin_account_id=$1
    ORDER BY COALESCE(revoked_at,'infinity'::timestamptz),registered_at,device_id
  `, [accountId]);
  return result.rows;
}

async function policyEvent(account, cfg, decision, reason, detail = {}) {
  await query(`
    INSERT INTO stream_policy_events(customer_id,server_id,jellyfin_account_id,jellyfin_session_id,mode,decision,stream_count,stream_limit,reason,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
  `, [account.customer_id,account.server_id,account.account_id,detail.sessionId || null,
    cfg.effectiveMode,decision,detail.registeredCount ?? null,detail.deviceLimit ?? null,reason,
    JSON.stringify({ planId: account.plan_id || null, subscriptionId: account.subscription_id || null, accessLane: lane(account.access_lane), ...detail })]);
}

function observedDevices(sessions, jellyfinUserId) {
  const userId = String(jellyfinUserId || '').toLowerCase();
  const unique = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.Id || String(session.UserId || '').toLowerCase() !== userId) continue;
    const deviceId = safeDeviceId(session.DeviceId);
    if (!deviceId) continue;
    const row = {
      sessionId: String(session.Id),
      deviceId,
      deviceName: clean(session.DeviceName, 300),
      clientName: clean(session.Client, 200),
      lastActivityMs: lastActivityMs(session),
      playing: Boolean(session.NowPlayingItem),
      paused: Boolean(session?.PlayState?.IsPaused)
    };
    const existing = unique.get(deviceId);
    if (!existing || row.lastActivityMs < existing.lastActivityMs) unique.set(deviceId, row);
  }
  return [...unique.values()].sort((a, b) => a.lastActivityMs - b.lastActivityMs || a.deviceId.localeCompare(b.deviceId));
}

async function registerObserved(account, deviceLimit, sessions) {
  if (!account.subscription_id) return { registered: [], claimed: [], observed: [] };
  const observed = observedDevices(sessions, account.jellyfin_user_id);
  return transaction(async client => {
    await client.query(`
      INSERT INTO media_account_device_policy(jellyfin_account_id,subscription_id,managed,enforced,device_limit,updated_at)
      VALUES($1,$2,TRUE,FALSE,$3,NOW())
      ON CONFLICT(jellyfin_account_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,managed=TRUE,device_limit=EXCLUDED.device_limit,updated_at=NOW()
    `, [account.account_id,account.subscription_id,deviceLimit]);

    let registered = await activeDevices(account.subscription_id, client);
    if (registered.length > deviceLimit) {
      const revoke = registered.slice(deviceLimit).map(row => row.id);
      await client.query(`UPDATE media_account_devices SET revoked_at=NOW(),updated_at=NOW() WHERE id=ANY($1::uuid[])`, [revoke]);
      registered = registered.slice(0, deviceLimit);
    }

    const byId = new Map(registered.map(row => [String(row.device_id), row]));
    for (const item of observed) {
      if (!byId.has(item.deviceId)) continue;
      await client.query(`
        UPDATE media_account_devices SET device_name=COALESCE($3,device_name),client_name=COALESCE($4,client_name),last_seen_at=NOW(),updated_at=NOW()
        WHERE subscription_id=$1 AND device_id=$2 AND revoked_at IS NULL
      `, [account.subscription_id,item.deviceId,item.deviceName,item.clientName]);
    }

    let capacity = Math.max(0, deviceLimit - registered.length);
    const claimed = [];
    for (const item of observed) {
      if (!capacity || byId.has(item.deviceId)) continue;
      const inserted = await client.query(`
        INSERT INTO media_account_devices(jellyfin_account_id,subscription_id,device_id,device_name,client_name,registered_at,last_seen_at,revoked_at,updated_at)
        VALUES($1,$2,$3,$4,$5,NOW(),NOW(),NULL,NOW())
        ON CONFLICT(subscription_id,device_id) WHERE subscription_id IS NOT NULL DO UPDATE SET
          device_name=COALESCE(EXCLUDED.device_name,media_account_devices.device_name),
          client_name=COALESCE(EXCLUDED.client_name,media_account_devices.client_name),
          registered_at=CASE WHEN media_account_devices.revoked_at IS NOT NULL THEN NOW() ELSE media_account_devices.registered_at END,
          last_seen_at=NOW(),revoked_at=NULL,updated_at=NOW()
        RETURNING id,jellyfin_account_id,subscription_id,device_id,device_name,client_name,registered_at,last_seen_at,revoked_at
      `, [account.account_id,account.subscription_id,item.deviceId,item.deviceName,item.clientName]);
      const row = inserted.rows[0];
      byId.set(item.deviceId, row);
      registered.push(row);
      claimed.push({ ...item, row });
      capacity -= 1;
    }

    registered.sort((a, b) => new Date(a.registered_at) - new Date(b.registered_at) || String(a.device_id).localeCompare(String(b.device_id)));
    return { registered, claimed, observed };
  });
}

async function remoteUserPolicy(account) {
  const user = await registry.request(account.server_id, `/Users/${encodeURIComponent(account.jellyfin_user_id)}`, { timeoutMs: 7000 });
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Media server returned an invalid user response.');
  return { user, policy: user.Policy && typeof user.Policy === 'object' ? { ...user.Policy } : {} };
}

async function applyRemoteAllowlist(account, deviceIds) {
  const { policy } = await remoteUserPolicy(account);
  if (policy.IsDisabled === true) return { applied: false, disabled: true };
  const ids = [...new Set((deviceIds || []).map(safeDeviceId).filter(Boolean))];
  await registry.request(account.server_id, `/Users/${encodeURIComponent(account.jellyfin_user_id)}/Policy`, {
    method: 'POST',
    timeoutMs: 7000,
    bypassDevicePolicy: true,
    body: { ...policy, EnableAllDevices: ids.length === 0, EnabledDevices: ids }
  });
  return { applied: true, deviceIds: ids };
}

async function markApplied(account, deviceLimit, deviceIds, { enforced, error = null } = {}) {
  await query(`
    INSERT INTO media_account_device_policy(jellyfin_account_id,subscription_id,managed,enforced,device_limit,last_applied_devices,last_applied_at,last_error,updated_at)
    VALUES($1,$2,TRUE,$3,$4,$5::text[],CASE WHEN $3 THEN NOW() ELSE NULL END,$6,NOW())
    ON CONFLICT(jellyfin_account_id) DO UPDATE SET
      subscription_id=EXCLUDED.subscription_id,managed=TRUE,enforced=EXCLUDED.enforced,device_limit=EXCLUDED.device_limit,
      last_applied_devices=EXCLUDED.last_applied_devices,
      last_applied_at=CASE WHEN EXCLUDED.enforced THEN NOW() ELSE media_account_device_policy.last_applied_at END,
      last_error=EXCLUDED.last_error,updated_at=NOW()
  `, [account.account_id,account.subscription_id || null,Boolean(enforced),deviceLimit,deviceIds || [],error ? String(error).slice(0,1000) : null]);
}

async function releaseRemoteRestriction(account, { revokeDevices = false, subscriptionId = null } = {}) {
  await applyRemoteAllowlist(account, []);
  const revokeSubscriptionId = subscriptionId || account.stored_subscription_id || account.subscription_id || null;
  await transaction(async client => {
    if (revokeDevices && revokeSubscriptionId) {
      await client.query(`UPDATE media_account_devices SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW() WHERE subscription_id=$1 AND revoked_at IS NULL`, [revokeSubscriptionId]);
    }
    await client.query(`
      INSERT INTO media_account_device_policy(jellyfin_account_id,subscription_id,managed,enforced,device_limit,last_applied_devices,last_applied_at,last_error,updated_at)
      VALUES($1,$2,$3,FALSE,$4,'{}'::text[],NOW(),NULL,NOW())
      ON CONFLICT(jellyfin_account_id) DO UPDATE SET
        subscription_id=EXCLUDED.subscription_id,managed=EXCLUDED.managed,enforced=FALSE,device_limit=EXCLUDED.device_limit,last_applied_devices='{}'::text[],last_applied_at=NOW(),last_error=NULL,updated_at=NOW()
    `, [account.account_id,account.subscription_id || null,!revokeDevices,revokeDevices ? null : account.effectiveDeviceLimit]);
  });
}

async function stopUnauthorizedPlayback(account, sessions, allowedIds, cfg) {
  if (cfg.effectiveMode !== 'enforce') return 0;
  const allowed = new Set((allowedIds || []).map(String));
  let stopped = 0;
  for (const session of observedDevices(sessions, account.jellyfin_user_id)) {
    if (allowed.has(session.deviceId) || !session.playing) continue;
    try {
      await registry.request(account.server_id, `/Sessions/${encodeURIComponent(session.sessionId)}/Message`, {
        method: 'POST', timeoutMs: 5000,
        body: {
          Header: 'Device access limit reached',
          Text: `This plan allows ${account.effectiveDeviceLimit} registered device${account.effectiveDeviceLimit === 1 ? '' : 's'}. This device is not authorised. Contact support if your registered devices need to be reset.`,
          TimeoutMs: 8000
        }
      });
    } catch (_) {}
    try {
      await registry.request(account.server_id, `/Sessions/${encodeURIComponent(session.sessionId)}/Playing/Stop`, { method: 'POST', timeoutMs: 5000 });
      stopped += 1;
      await policyEvent(account,cfg,'stopped',DEVICE_ALLOWLIST_REASON,{sessionId:session.sessionId,deviceId:session.deviceId,deviceLimit:account.effectiveDeviceLimit,registeredCount:allowed.size,unauthorised:true});
    } catch (error) {
      await policyEvent(account,cfg,'stop_failed',DEVICE_ALLOWLIST_ERROR_REASON,{sessionId:session.sessionId,deviceId:session.deviceId,deviceLimit:account.effectiveDeviceLimit,registeredCount:allowed.size,error:error.message});
    }
  }
  return stopped;
}

async function reconcileAccount(account, sessions, cfg) {
  const limit = Number(account.effectiveDeviceLimit || 0);
  let currentlyManaged = Boolean(account.device_policy_managed);
  let currentlyEnforced = Boolean(account.device_policy_enforced);
  const entitlementChanged = currentlyManaged && !sameId(account.stored_subscription_id, account.subscription_id);

  // A registered-device allowance belongs to one entitlement, not forever to
  // the Jellyfin account. A new subscription starts with fresh slots. A server
  // move under the SAME subscription reuses the subscription-scoped slots.
  if (entitlementChanged) {
    try {
      await releaseRemoteRestriction(account, { revokeDevices: true, subscriptionId: account.stored_subscription_id });
      currentlyManaged = false;
      currentlyEnforced = false;
    } catch (error) {
      await query(`UPDATE media_account_device_policy SET last_error=$2,updated_at=NOW() WHERE jellyfin_account_id=$1`, [account.account_id,String(error.message || error).slice(0,1000)]);
      return { released: 0, registered: 0, stopped: 0, error: error.message };
    }
  }

  if (!Number.isInteger(limit) || limit < 1 || !account.subscription_id) {
    if (currentlyManaged || currentlyEnforced) {
      try { await releaseRemoteRestriction(account, { revokeDevices: true }); }
      catch (error) {
        await query(`UPDATE media_account_device_policy SET last_error=$2,updated_at=NOW() WHERE jellyfin_account_id=$1`, [account.account_id,String(error.message || error).slice(0,1000)]);
        return { released: 0, registered: 0, stopped: 0, error: error.message };
      }
      return { released: 1, registered: 0, stopped: 0 };
    }
    return { released: entitlementChanged ? 1 : 0, registered: 0, stopped: 0 };
  }

  const state = await registerObserved(account, limit, sessions);
  for (const claim of state.claimed) {
    await policyEvent(account,cfg,'observed',DEVICE_REGISTERED_REASON,{sessionId:claim.sessionId,deviceId:claim.deviceId,deviceName:claim.deviceName,clientName:claim.clientName,deviceLimit:limit,registeredCount:state.registered.length});
  }

  const ids = state.registered.map(row => String(row.device_id));
  if (cfg.effectiveMode !== 'enforce') {
    if (currentlyEnforced) {
      try { await releaseRemoteRestriction({ ...account, effectiveDeviceLimit: limit }, { revokeDevices: false }); }
      catch (error) { await markApplied(account,limit,ids,{enforced:true,error:error.message}); return { released:0,registered:state.claimed.length,stopped:0,error:error.message }; }
    } else {
      await markApplied(account,limit,ids,{enforced:false});
    }
    return { released: (currentlyEnforced || entitlementChanged) ? 1 : 0, registered: state.claimed.length, stopped: 0, observedOnly: true };
  }

  if (!ids.length) {
    await markApplied(account,limit,[],{enforced:false});
    return { released: entitlementChanged ? 1 : 0, registered: 0, stopped: 0, awaitingFirstDevice: true };
  }

  // Do not close the media server's native device allowlist until every slot
  // has actually been claimed. Jellyfin/Emby cannot approve a new device that
  // has never connected, so applying EnabledDevices after the first claim on a
  // multi-device plan would make the remaining slots impossible to fill.
  if (ids.length < limit) {
    if (currentlyEnforced) {
      try {
        await releaseRemoteRestriction({ ...account, effectiveDeviceLimit: limit }, { revokeDevices: false });
      } catch (error) {
        await markApplied(account,limit,ids,{enforced:true,error:error.message});
        return { released:0,registered:state.claimed.length,stopped:0,error:error.message };
      }
    } else {
      await markApplied(account,limit,ids,{enforced:false});
    }
    return { released: (currentlyEnforced || entitlementChanged) ? 1 : 0, registered: state.claimed.length, stopped: 0, awaitingAdditionalDevices: true };
  }

  try {
    const applied = await applyRemoteAllowlist(account, ids);
    await markApplied(account,limit,ids,{enforced:Boolean(applied.applied)});
    await policyEvent(account,cfg,'observed',DEVICE_ALLOWLIST_REASON,{deviceLimit:limit,registeredCount:ids.length,deviceIds:ids,remoteDisabled:Boolean(applied.disabled)});
    return { released:entitlementChanged ? 1 : 0,registered:state.claimed.length,stopped:await stopUnauthorizedPlayback({ ...account, effectiveDeviceLimit: limit },sessions,ids,cfg),enforced:Boolean(applied.applied) };
  } catch (error) {
    await markApplied(account,limit,ids,{enforced:false,error:error.message});
    await policyEvent(account,cfg,'skipped_safety',DEVICE_ALLOWLIST_ERROR_REASON,{deviceLimit:limit,registeredCount:ids.length,error:error.message});
    return { released:entitlementChanged ? 1 : 0,registered:state.claimed.length,stopped:0,error:error.message };
  }
}

async function runDeviceAccessPolicyCycle({ failedServerIds = [] } = {}) {
  const cfg = activity.config();
  const failed = new Set((failedServerIds || []).map(String));
  const accounts = await accountsForDevicePolicy();
  const planIds = accounts.map(row => row.plan_id).filter(Boolean).map(String);
  const settings = await mediaPlanPolicy.getMany(planIds);
  for (const account of accounts) {
    const policy = account.plan_id ? settings.get(String(account.plan_id)) : null;
    account.effectiveDeviceLimit = policy?.deviceLimit ?? null;
  }

  const byServer = new Map();
  for (const account of accounts) {
    if (!byServer.has(String(account.server_id))) byServer.set(String(account.server_id), []);
    byServer.get(String(account.server_id)).push(account);
  }

  const summary = { accounts: accounts.length, registered: 0, enforced: 0, released: 0, stopped: 0, failed: 0, safetySkipped: 0 };
  for (const [serverId, rows] of byServer) {
    if (failed.has(serverId)) { summary.safetySkipped += rows.length; continue; }
    let sessions;
    try {
      sessions = await registry.request(serverId, `/Sessions?activeWithinSeconds=${SESSION_WINDOW_SECONDS}`, { timeoutMs: 7000 });
      if (!Array.isArray(sessions)) throw new Error('Unexpected sessions response');
    } catch (_) {
      summary.safetySkipped += rows.length;
      continue;
    }
    for (const account of rows) {
      const outcome = await reconcileAccount(account, sessions, cfg);
      summary.registered += Number(outcome.registered || 0);
      summary.enforced += outcome.enforced ? 1 : 0;
      summary.released += Number(outcome.released || 0);
      summary.stopped += Number(outcome.stopped || 0);
      if (outcome.error) summary.failed += 1;
    }
  }
  return { mode: cfg.effectiveMode, ...summary };
}

async function customerDeviceState(customerId) {
  const accounts = await accountsForDevicePolicy(customerId);
  const settings = await mediaPlanPolicy.getMany(accounts.map(row => row.plan_id).filter(Boolean).map(String));
  const out = [];
  for (const account of accounts) {
    const policy = account.plan_id ? settings.get(String(account.plan_id)) : null;
    const deviceLimit = policy?.deviceLimit ?? null;
    const devices = await allDevices(account.account_id, account.subscription_id || null);
    out.push({
      accountId: String(account.account_id),
      customerId: String(account.customer_id),
      subscriptionId: account.subscription_id ? String(account.subscription_id) : null,
      serverId: String(account.server_id),
      serverName: account.server_name,
      provider: String(account.media_server_type || 'jellyfin'),
      username: account.jellyfin_username,
      deviceLimit,
      managed: Boolean(account.device_policy_managed) && sameId(account.stored_subscription_id, account.subscription_id),
      enforced: Boolean(account.device_policy_enforced) && sameId(account.stored_subscription_id, account.subscription_id),
      lastAppliedAt: account.last_applied_at,
      lastError: account.last_error,
      resetAt: account.reset_at,
      devices: devices.map(row => ({
        id: String(row.id), subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
        deviceId: row.device_id, deviceName: row.device_name, clientName: row.client_name,
        registeredAt: row.registered_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at
      }))
    });
  }
  return out;
}

async function resetAccountDevices(customerId, accountId) {
  const found = await query(`
    SELECT ja.id AS account_id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,
           COALESCE(js.media_server_type,'jellyfin') AS media_server_type,js.name AS server_name,
           mdp.subscription_id,mdp.managed,mdp.enforced,mdp.device_limit
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN media_account_device_policy mdp ON mdp.jellyfin_account_id=ja.id
    WHERE ja.id=$1 AND ja.customer_id=$2 AND ja.account_purpose='jellyfin'
  `, [accountId,customerId]);
  const account = found.rows[0];
  if (!account) throw new Error('Media account not found for this customer.');
  if (!account.managed && !(await activeDevices(account.subscription_id)).length) throw new Error('This account does not have CAPTAiNFiN-managed registered devices to reset.');

  const previous = await activeDevices(account.subscription_id);
  await applyRemoteAllowlist(account, []);
  await transaction(async client => {
    if (account.subscription_id) {
      await client.query(`UPDATE media_account_devices SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW() WHERE subscription_id=$1 AND revoked_at IS NULL`, [account.subscription_id]);
    }
    await client.query(`
      INSERT INTO media_account_device_policy(jellyfin_account_id,subscription_id,managed,enforced,device_limit,last_applied_devices,last_applied_at,last_error,reset_at,updated_at)
      VALUES($1,$2,TRUE,FALSE,$3,'{}'::text[],NOW(),NULL,NOW(),NOW())
      ON CONFLICT(jellyfin_account_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,enforced=FALSE,last_applied_devices='{}'::text[],last_applied_at=NOW(),last_error=NULL,reset_at=NOW(),updated_at=NOW()
    `, [account.account_id,account.subscription_id || null,account.device_limit || null]);
  });
  return { account, previousDevices: previous };
}

module.exports = {
  DEVICE_REGISTERED_REASON,
  DEVICE_ALLOWLIST_REASON,
  DEVICE_ALLOWLIST_ERROR_REASON,
  DEVICE_RESET_REASON,
  observedDevices,
  activeDevices,
  customerDeviceState,
  resetAccountDevices,
  runDeviceAccessPolicyCycle,
  applyRemoteAllowlist
};
