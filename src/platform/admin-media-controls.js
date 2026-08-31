'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const registry = require('../jellyfin/registry');
const { POLICY_REASON } = require('../jellyfin/four-k-transcode-policy');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
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
function redirectWith(res, path, kind, message, hash = '') {
  return res.redirect(`${path}?${kind}=${encodeURIComponent(message)}${hash ? `#${hash}` : ''}`);
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
                 OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
                 OR (COALESCE(s.service_extension_days,0)>0
                     AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
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
  const [audit, policy] = await Promise.all([
    query(`SELECT action,created_at,metadata FROM audit_log WHERE entity_type='plan' AND entity_id::text=$1 ORDER BY created_at DESC LIMIT 40`, [String(planId)]),
    query(`SELECT decision,mode,reason,created_at,detail FROM stream_policy_events WHERE reason=$2 AND detail->>'planId'=$1 ORDER BY created_at DESC LIMIT 40`, [String(planId), POLICY_REASON])
  ]);
  return { audit: audit.rows, policy: policy.rows };
}

async function serverInfo(serverId) {
  const result = await query(`SELECT id,name,COALESCE(media_server_type,'jellyfin') AS media_server_type,enabled,health_status,last_health_check FROM jellyfin_servers WHERE id=$1`, [serverId]);
  return result.rows[0] || null;
}

async function managedAccounts(serverId) {
  const result = await query(`
    SELECT ja.jellyfin_user_id,ja.customer_id,c.email,c.username
    FROM jellyfin_accounts ja
    JOIN customers c ON c.id=ja.customer_id
    WHERE ja.server_id=$1 AND ja.account_purpose='jellyfin' AND ja.disabled=FALSE
  `, [serverId]);
  return new Map(result.rows.map(row => [String(row.jellyfin_user_id || '').toLowerCase(), row]));
}

async function activeManagedSessions(serverId) {
  const server = await serverInfo(serverId);
  if (!server) throw new Error('Server not found.');
  if (String(server.media_server_type) !== 'jellyfin') return { server, sessions: [], targets: [], supportsMessaging: false };
  const [accounts, sessions] = await Promise.all([managedAccounts(serverId), registry.request(serverId, '/Sessions')]);
  if (!Array.isArray(sessions)) throw new Error('Jellyfin returned an unexpected sessions response.');
  const managed = sessions.filter(session => session?.Id && session?.UserId && accounts.has(String(session.UserId).toLowerCase())).map(session => {
    const account = accounts.get(String(session.UserId).toLowerCase());
    return {
      sessionId: String(session.Id),
      customerId: String(account.customer_id),
      label: account.email || account.username || String(account.customer_id),
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
  return { server, sessions: managed, targets: [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label)), supportsMessaging: true };
}

async function serverLogs(serverId) {
  const [audit, policy] = await Promise.all([
    query(`SELECT action,created_at,metadata FROM audit_log WHERE entity_type='jellyfin_server' AND entity_id::text=$1 ORDER BY created_at DESC LIMIT 40`, [String(serverId)]),
    query(`SELECT decision,mode,reason,created_at,detail FROM stream_policy_events WHERE server_id=$1 ORDER BY created_at DESC LIMIT 40`, [serverId])
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

function createAdminMediaControlsRouter() {
  const router = express.Router();
  router.use('/admin/media-controls', gate, noStore);

  router.get(`/admin/media-controls/plan/:planId(${UUID})/state`, async (req, res, next) => {
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).json({ error: 'Plan not found.' });
      if (!jellyfinPlanState(state)) return res.status(400).json({ error: '4K transcode policy applies only to Jellyfin media plans.' });
      return res.json({
        id: state.id,
        name: state.name,
        code: state.code,
        kick4kTranscodes: Boolean(state.kick_4k_transcodes),
        liveEntitlements: Number(state.live_entitlements || 0)
      });
    } catch (error) { return next(error); }
  });

  router.get(`/admin/media-controls/plan/:planId(${UUID})/logs`, async (req, res, next) => {
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).json({ error: 'Plan not found.' });
      if (!jellyfinPlanState(state)) return res.status(400).json({ error: 'Media-policy logs apply only to Jellyfin media plans.' });
      return res.json(await planLogs(req.params.planId));
    } catch (error) { return next(error); }
  });

  router.post(`/admin/media-controls/plan/:planId(${UUID})/4k-transcode`, writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    const back = `/admin/plans/${encodeURIComponent(req.params.planId)}/edit`;
    try {
      const state = await planState(req.params.planId);
      if (!state) return res.status(404).send('Plan not found');
      if (!jellyfinPlanState(state)) throw new Error('4K transcode policy applies only to Jellyfin media plans.');
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
      return redirectWith(res, back, 'message', `4K video transcoding kick ${enabled ? 'enabled' : 'disabled'} for ${state.name}. Direct-play 4K is unaffected.`, 'advanced-settings');
    } catch (error) {
      return redirectWith(res, back, 'error', error.message || '4K transcode policy could not be saved.', 'advanced-settings');
    }
  });

  router.get(`/admin/media-controls/server/:serverId(${UUID})/state`, async (req, res, next) => {
    try {
      const state = await activeManagedSessions(req.params.serverId);
      return res.json({
        server: state.server,
        supportsMessaging: state.supportsMessaging,
        activeSessions: state.sessions.length,
        targets: state.targets
      });
    } catch (error) { return next(error); }
  });

  router.get(`/admin/media-controls/server/:serverId(${UUID})/logs`, async (req, res, next) => {
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
      if (!state.supportsMessaging) throw new Error('In-client messaging is currently available for Jellyfin servers only.');
      const targets = state.sessions.filter(session => !requestedCustomer || session.customerId === requestedCustomer).slice(0, 200);
      if (!targets.length) throw new Error(requestedCustomer ? 'That customer has no active Jellyfin session on this server.' : 'There are no active managed Jellyfin sessions on this server.');

      const results = await sendInBatches(targets, target => registry.request(req.params.serverId, `/Sessions/${encodeURIComponent(target.sessionId)}/Message`, {
        method: 'POST', timeoutMs: 5000, body: { Header: header, Text: text, TimeoutMs: timeoutMs }
      }));
      const sent = results.filter(result => result.ok).length;
      const failed = results.length - sent;
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin.message.send','jellyfin_server',$2,$3::jsonb)`, [
        req.session.authUserId,
        req.params.serverId,
        JSON.stringify({ header, text, timeoutMs, audience: requestedCustomer ? 'customer' : 'all_active', customerId: requestedCustomer || null, attempted: results.length, sent, failed })
      ]);
      if (!sent) throw new Error(`Jellyfin did not accept the message on ${failed} active session${failed === 1 ? '' : 's'}.`);
      const resultMessage = failed
        ? `Message delivered to ${sent} active Jellyfin session${sent === 1 ? '' : 's'}; ${failed} failed.`
        : `Message delivered to ${sent} active Jellyfin session${sent === 1 ? '' : 's'}.`;
      return redirectWith(res, back, failed ? 'error' : 'message', resultMessage, 'basic-settings');
    } catch (error) {
      return redirectWith(res, back, 'error', error.message || 'Jellyfin message could not be sent.', 'basic-settings');
    }
  });

  router.use('/admin/media-controls', (error, _req, res, _next) => {
    console.error('Admin media controls error:', error.message);
    if (res.headersSent) return;
    return res.status(500).json({ error: 'Media controls are temporarily unavailable.' });
  });
  return router;
}

module.exports = {
  createAdminMediaControlsRouter,
  cleanMessage,
  safeInt,
  jellyfinPlanState,
  planState,
  activeManagedSessions,
  sendInBatches
};