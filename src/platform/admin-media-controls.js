'use strict';

const express = require('express');
const { getPool, query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const registry = require('../jellyfin/registry');
const mediaProvider = require('../media-servers/provider');
const mediaPlanPolicy = require('../jellyfin/media-plan-policy-settings');
const deviceAccessPolicy = require('../jellyfin/device-access-policy');
const { POLICY_REASON } = require('../jellyfin/four-k-transcode-policy');
const { IDENTITY_ADVISORY_LOCK_ID, IP_REASON, DEVICE_REASON, COMBINED_REASON } = require('../jellyfin/media-identity-policy');
const { SENT_REASON, FAILED_REASON } = require('../jellyfin/payg-expiry-messages');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const readLimit = routeRateLimit.middleware({ scope: 'admin-jellyfin-media-controls-read', max: 180, windowSeconds: 60, reason: 'admin_jellyfin_media_controls_read' });
const writeLimit = routeRateLimit.middleware({ scope: 'admin-jellyfin-media-controls', max: 30, windowSeconds: 60, reason: 'admin_jellyfin_media_controls' });

function gate(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function bool(value) { return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase()); }
function cleanMessage(value, max, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`${label} contains unsupported control characters.`);
  return text;
}
function safeInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function optionalLimit(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '0') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 200) throw new Error(`${label} must be 0 for unlimited or a whole number from 1 to 200.`);
  return parsed;
}
function redirectWith(res, path, kind, message, hash = '') {
  return res.redirect(`${path}?${kind}=${encodeURIComponent(message)}${hash ? `#${hash}` : ''}`);
}
function customerAccessRedirect(res, customerId, kind, message) {
  return res.redirect(`/admin/users/${encodeURIComponent(customerId)}?tab=access&${kind}=${encodeURIComponent(message)}#media-device-access`);
}
function jellyfinPlanState(state) {
  return Boolean(state)
    && !Boolean(state.is_addon)
    && ['jellyfin', 'bundle'].includes(String(state.service_type || 'jellyfin'));
}

async function planState(planId) {
  const result = await query(`
    SELECT p.id,p.name,p.code,p.kick_4k_transcodes,
           COALESCE(p.service_type,'jellyfin') AS service_type,COALESCE(p.is_addon,FALSE) AS is_addon,
           COUNT(DISTINCT s.customer_id) FILTER (
             WHERE s.superseded_by IS NULL
               AND s.starts_at<=NOW()
               AND (
                 (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
                 OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
                 OR (COALESCE(s.service_extension_days,0)>0
                     AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
                     AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
               )
           )::int AS live_entitlements
    FROM plans p
    LEFT JOIN subscriptions s ON s.plan_id=p.id
    LEFT JOIN customer_entitlement_overrides o
           ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    WHERE p.id=$1
    GROUP BY p.id
  `, [planId]);
  return result.rows[0] || null;
}

async function planLogs(planId) {
  const reasons = [
    POLICY_REASON, IP_REASON, DEVICE_REASON, COMBINED_REASON, SENT_REASON, FAILED_REASON,
    deviceAccessPolicy.DEVICE_REGISTERED_REASON,
    deviceAccessPolicy.DEVICE_ALLOWLIST_REASON,
    deviceAccessPolicy.DEVICE_ALLOWLIST_ERROR_REASON,
    deviceAccessPolicy.DEVICE_RESET_REASON
  ];
  const [audit, policy] = await Promise.all([
    query(`SELECT action,created_at,metadata FROM audit_log WHERE entity_type='plan' AND entity_id::text=$1 ORDER BY created_at DESC LIMIT 40`, [String(planId)]),
    query(`SELECT decision,mode,reason,created_at,detail FROM stream_policy_events WHERE detail->>'planId'=$1 AND reason=ANY($2::text[]) ORDER BY created_at DESC LIMIT 80`, [String(planId), reasons])
  ]);
  return { audit: audit.rows, policy: policy.rows };
}

async function serverInfo(serverId) {
  const result = await query(`SELECT id,name,COALESCE(media_server_type,'jellyfin') AS media_server_type,enabled,health_status,last_health_check FROM jellyfin_servers WHERE id=$1`, [serverId]);
  return result.rows[0] || null;
}

async function managedAccounts(serverId) {
  const result = await query(`
    SELECT ja.jellyfin_user_id,ja.customer_id,ja.jellyfin_username,
           c.email,c.display_name,au.username AS login_username
    FROM jellyfin_accounts ja
    JOIN customers c ON c.id=ja.customer_id
    LEFT JOIN app_users au ON au.id=c.user_id
    WHERE ja.server_id=$1 AND ja.account_purpose='jellyfin' AND ja.disabled=FALSE
  `, [serverId]);
  return new Map(result.rows.map(row => [String(row.jellyfin_user_id || '').toLowerCase(), row]));
}

async function activeManagedSessions(serverId) {
  const server = await serverInfo(serverId);
  if (!server) throw new Error('Server not found.');
  const type = mediaProvider.normalizeType(server.media_server_type || 'jellyfin');
  const providerLabel = mediaProvider.label(type);
  const accounts = await managedAccounts(serverId);
  let sessions;
  try {
    sessions = await registry.request(serverId, '/Sessions');
  } catch (_) {
    console.warn('Media-server message audience lookup failed for a configured server.');
    return { server, providerLabel, sessions: [], targets: [], supportsMessaging: true, messagingError: `Active ${providerLabel} sessions could not be loaded. Check server connectivity and trusted-network settings.` };
  }
  if (!Array.isArray(sessions)) return { server, providerLabel, sessions: [], targets: [], supportsMessaging: true, messagingError: `${providerLabel} returned an unexpected sessions response.` };
  const managed = sessions.filter(session => session?.Id && session?.UserId && accounts.has(String(session.UserId).toLowerCase())).map(session => {
    const account = accounts.get(String(session.UserId).toLowerCase());
    return {
      sessionId: String(session.Id),
      customerId: String(account.customer_id),
      label: account.display_name || account.email || account.login_username || account.jellyfin_username || String(account.customer_id),
      client: String(session.Client || ''),
      device: String(session.DeviceName || session.DeviceId || ''),
      playing: session?.NowPlayingItem?.Name ? String(session.NowPlayingItem.Name) : null
    };
  });
  const grouped = new Map();
  for (const session of managed) {
    if (!grouped.has(session.customerId)) grouped.set(session.customerId, { customerId: session.customerId, label: session.label, sessions: 0 });
    grouped.get(session.customerId).sessions += 1;
  }
  return { server, providerLabel, sessions: managed, targets: [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label)), supportsMessaging: true, messagingError: null };
}

async function serverLogs(serverId) {
  const [audit, policy] = await Promise.all([
    query(`SELECT action,created_at,metadata FROM audit_log WHERE entity_type='jellyfin_server' AND entity_id::text=$1 ORDER BY created_at DESC LIMIT 40`, [String(serverId)]),
    query(`SELECT decision,mode,reason,created_at,detail FROM stream_policy_events WHERE server_id=$1 ORDER BY created_at DESC LIMIT 80`, [serverId])
  ]);
  return { audit: audit.rows, policy: policy.rows };
}

async function sendInBatches(items, send, concurrency = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(async item => {
      try { await send(item); return { ok: true, item }; }
      catch (error) { return { ok: false, item, error: error.message }; }
    })));
  }
  return results;
}

async function withMediaIdentityLock(work, { waitMs = 10000, pollMs = 100 } = {}) {
  const client = await getPool().connect();
  let locked = false;
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  try {
    do {
      const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [IDENTITY_ADVISORY_LOCK_ID]);
      locked = Boolean(result.rows[0]?.locked);
      if (locked) break;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.max(10, Number(pollMs) || 100)));
    } while (!locked);
    if (!locked) throw new Error('Playback/device policy reconciliation is busy. Try resetting registered devices again in a moment.');
    return await work();
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [IDENTITY_ADVISORY_LOCK_ID]); } catch (_) {}
    }
    client.release();
  }
}

function createAdminMediaControlsRouter() {
  const router = express.Router();
  router.use('/admin/media-controls', gate, noStore);

  router.get(`/admin/media-controls/plan/:planId(${UUID})/state`, readLimit, async (req, res, next) => {
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).json({ error: 'Plan not found.' });
      if (!jellyfinPlanState(state)) return res.status(400).json({ error: 'Media playback policy applies only to Jellyfin/Emby plans.' });
      const connectionPolicy = await mediaPlanPolicy.get(req.params.planId);
      return res.json({
        id: state.id,
        name: state.name,
        code: state.code,
        kick4kTranscodes: Boolean(state.kick_4k_transcodes),
        ipLimit: connectionPolicy.ipLimit,
        deviceLimit: connectionPolicy.deviceLimit,
        paygExpiryMessagesEnabled: connectionPolicy.paygExpiryMessagesEnabled !== false,
        liveEntitlements: Number(state.live_entitlements || 0)
      });
    } catch (error) { return next(error); }
  });

  router.get(`/admin/media-controls/plan/:planId(${UUID})/logs`, readLimit, async (req, res, next) => {
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).json({ error: 'Plan not found.' });
      if (!jellyfinPlanState(state)) return res.status(400).json({ error: 'Media-policy logs apply only to Jellyfin/Emby plans.' });
      return res.json(await planLogs(req.params.planId));
    } catch (error) { return next(error); }
  });

  router.post(`/admin/media-controls/plan/:planId(${UUID})/connection-policy`, writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    const back = `/admin/plans/${encodeURIComponent(req.params.planId)}/edit`;
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).send('Plan not found');
      if (!jellyfinPlanState(state)) throw new Error('Media connection policy applies only to Jellyfin/Emby plans.');
      const previous = await mediaPlanPolicy.get(req.params.planId);
      const next = {
        ipLimit: optionalLimit(req.body.ipLimit, 'Active IP limit'),
        deviceLimit: optionalLimit(req.body.deviceLimit, 'Registered device limit'),
        paygExpiryMessagesEnabled: bool(req.body.paygExpiryMessagesEnabled)
      };
      const destructiveChange = previous.ipLimit !== next.ipLimit || previous.deviceLimit !== next.deviceLimit;
      if (destructiveChange && Number(state.live_entitlements || 0) > 0 && String(req.body.confirmation || '').trim() !== String(state.code)) {
        throw new Error(`This plan has ${Number(state.live_entitlements)} live entitlement${Number(state.live_entitlements) === 1 ? '' : 's'}. Type ${state.code} exactly to confirm IP/device-limit changes.`);
      }
      await mediaPlanPolicy.save(req.params.planId, next, req.session.authUserId);
      return redirectWith(res, back, 'message', 'Media IP/device limits and Pay As You Go reminders saved.', 'access-advanced-settings');
    } catch (error) {
      return redirectWith(res, back, 'error', error.message || 'Media connection policy could not be saved.', 'access-advanced-settings');
    }
  });

  router.post(`/admin/media-controls/plan/:planId(${UUID})/4k-transcode`, writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    const back = `/admin/plans/${encodeURIComponent(req.params.planId)}/edit`;
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).send('Plan not found');
      if (!jellyfinPlanState(state)) throw new Error('4K transcode policy applies only to Jellyfin/Emby media plans.');
      const enabled = bool(req.body.enabled);
      const changing = Boolean(state.kick_4k_transcodes) !== enabled;
      if (changing && Number(state.live_entitlements || 0) > 0 && String(req.body.confirmation || '').trim() !== String(state.code)) {
        throw new Error(`This plan has ${Number(state.live_entitlements)} live entitlement${Number(state.live_entitlements) === 1 ? '' : 's'}. Type ${state.code} exactly to confirm the 4K transcode policy change.`);
      }
      await transaction(async client => {
        await client.query('UPDATE plans SET kick_4k_transcodes=$2,updated_at=NOW() WHERE id=$1', [req.params.planId, enabled]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.4k_transcode_policy','plan',$2,$3::jsonb)`, [
          req.session.authUserId,
          req.params.planId,
          JSON.stringify({ enabled, previous: Boolean(state.kick_4k_transcodes), liveEntitlements: Number(state.live_entitlements || 0) })
        ]);
      });
      return redirectWith(res, back, 'message', `4K video transcoding kick ${enabled ? 'enabled' : 'disabled'} for ${state.name}. Direct-play 4K is unaffected.`, 'access-advanced-settings');
    } catch (error) {
      return redirectWith(res, back, 'error', error.message || '4K transcode policy could not be saved.', 'access-advanced-settings');
    }
  });

  router.get(`/admin/media-controls/customer/:customerId(${UUID})/devices`, readLimit, async (req, res, next) => {
    try {
      return res.json({ accounts: await deviceAccessPolicy.customerDeviceState(req.params.customerId) });
    } catch (error) { return next(error); }
  });

  router.post(`/admin/media-controls/customer/:customerId(${UUID})/devices/:accountId(${UUID})/reset`, writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const result = await withMediaIdentityLock(() => deviceAccessPolicy.resetAccountDevices(req.params.customerId, req.params.accountId));
      await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'admin.media_device_access.reset','jellyfin_account',$2,$3::jsonb)
      `, [req.session.authUserId, req.params.accountId, JSON.stringify({
        customerId: req.params.customerId,
        serverId: result.account.server_id,
        provider: result.account.media_server_type || 'jellyfin',
        previousDeviceCount: result.previousDevices.length,
        previousDeviceIds: result.previousDevices.map(row => row.device_id)
      })]);
      return customerAccessRedirect(res, req.params.customerId, 'message', `Registered device access reset. The next device${Number(result.account.device_limit || 0) === 1 ? '' : 's'} used will claim the available slot${Number(result.account.device_limit || 0) === 1 ? '' : 's'}.`);
    } catch (error) {
      return customerAccessRedirect(res, req.params.customerId, 'error', error.message || 'Registered device access could not be reset.');
    }
  });

  router.get(`/admin/media-controls/server/:serverId(${UUID})/state`, readLimit, async (req, res, next) => {
    try {
      const state = await activeManagedSessions(req.params.serverId);
      return res.json({
        server: state.server,
        providerLabel: state.providerLabel,
        supportsMessaging: state.supportsMessaging,
        messagingError: state.messagingError,
        activeSessions: state.sessions.length,
        targets: state.targets
      });
    } catch (error) { return next(error); }
  });

  router.get(`/admin/media-controls/server/:serverId(${UUID})/logs`, readLimit, async (req, res, next) => {
    try {
      if (!(await serverInfo(req.params.serverId))) return res.status(404).json({ error: 'Server not found.' });
      return res.json(await serverLogs(req.params.serverId));
    } catch (error) { return next(error); }
  });

  router.post(`/admin/media-controls/server/:serverId(${UUID})/message`, writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    const back = `/admin/servers/${encodeURIComponent(req.params.serverId)}/edit`;
    try {
      const header = cleanMessage(req.body.header || 'Message from administrator', 80, 'Message title');
      const text = cleanMessage(req.body.text, 500, 'Message');
      const timeoutMs = safeInt(req.body.timeoutSeconds, 3, 30, 8) * 1000;
      const requestedCustomer = String(req.body.customerId || '').trim();
      if (requestedCustomer && !(new RegExp(`^${UUID}$`)).test(requestedCustomer)) throw new Error('Choose a valid message audience.');

      const state = await activeManagedSessions(req.params.serverId);
      if (state.messagingError) throw new Error(`Active ${state.providerLabel} sessions could not be loaded. Check server connectivity first.`);
      const targets = state.sessions.filter(session => !requestedCustomer || session.customerId === requestedCustomer).slice(0, 200);
      if (!targets.length) throw new Error(requestedCustomer ? `That customer has no active ${state.providerLabel} session on this server.` : `There are no active managed ${state.providerLabel} sessions on this server.`);

      const results = await sendInBatches(targets, target => registry.request(req.params.serverId, `/Sessions/${encodeURIComponent(target.sessionId)}/Message`, {
        method: 'POST', timeoutMs: 5000, body: { Header: header, Text: text, TimeoutMs: timeoutMs }
      }));
      const sent = results.filter(result => result.ok).length;
      const failed = results.length - sent;
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin.message.send','jellyfin_server',$2,$3::jsonb)`, [
        req.session.authUserId,
        req.params.serverId,
        JSON.stringify({ provider: String(state.server.media_server_type || 'jellyfin'), header, text, timeoutMs, audience: requestedCustomer ? 'customer' : 'all_active', customerId: requestedCustomer || null, attempted: results.length, sent, failed })
      ]);
      if (!sent) throw new Error(`${state.providerLabel} did not accept the message on ${failed} active session${failed === 1 ? '' : 's'}.`);
      const resultMessage = failed
        ? `Message delivered to ${sent} active ${state.providerLabel} session${sent === 1 ? '' : 's'}; ${failed} failed.`
        : `Message delivered to ${sent} active ${state.providerLabel} session${sent === 1 ? '' : 's'}.`;
      return redirectWith(res, back, failed ? 'error' : 'message', resultMessage, 'basic-settings');
    } catch (error) {
      return redirectWith(res, back, 'error', error.message || 'Media-server message could not be sent.', 'basic-settings');
    }
  });

  router.use('/admin/media-controls', (_error, _req, res, _next) => {
    console.error('Admin media controls request failed.');
    if (res.headersSent) return;
    return res.status(500).json({ error: 'Media controls are temporarily unavailable.' });
  });
  return router;
}

module.exports = {
  createAdminMediaControlsRouter,
  cleanMessage,
  safeInt,
  optionalLimit,
  jellyfinPlanState,
  planState,
  activeManagedSessions,
  sendInBatches,
  withMediaIdentityLock
};