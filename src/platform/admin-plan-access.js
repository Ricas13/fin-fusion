'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const provisioning = require('../jellyfin/provisioning');
const audit = require('../audit');
const { esc, layout } = require('./admin-html');

const ACCESS_MODELS = ['concurrent_streams', 'household_network'];

function gate(req, res, next) {
  return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function checked(value) { return value ? 'checked' : ''; }
function selected(a, b) { return a === b ? 'selected' : ''; }
function b(value) { return value === true || ['on', 'true', '1', 'yes'].includes(String(value || '').toLowerCase()); }
function int(value, min, max, label) {
  const raw = String(value ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < min || parsed > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}
function serviceIncludes(plan, service) {
  const type = String(plan?.service_type || 'jellyfin');
  return type === service || type === 'bundle';
}
function planSubnav(plan, active) {
  const id = encodeURIComponent(plan.id);
  const links = [
    ['overview', `/admin/plans/${id}`, 'Overview'],
    ['access', `/admin/plans/${id}/jellyfin`, 'Access'],
    ['delivery', `/admin/plans/${id}/delivery`, 'Delivery'],
    ['libraries', `/admin/plans/${id}/libraries`, 'Libraries']
  ];
  return `<nav class="tabs">${links.map(([key, href, label]) => `<a class="${key === active ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}</nav>`;
}
async function loadPlan(id) {
  const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
  return result.rows[0] || null;
}
async function subscriberCount(planId) {
  const result = await query(
    `SELECT COUNT(*)::int count FROM subscriptions
     WHERE plan_id=$1 AND superseded_by IS NULL
       AND status IN ('active','trialing','past_due','paused')
       AND starts_at<=NOW()`,
    [planId]
  );
  return Number(result.rows[0]?.count || 0);
}
function values(plan, body = null) {
  const source = body || {};
  const jellyfin = serviceIncludes(plan, 'jellyfin');
  const stremio = serviceIncludes(plan, 'stremio');
  const accessModel = ACCESS_MODELS.includes(source.jellyfinAccessModel)
    ? source.jellyfinAccessModel
    : (ACCESS_MODELS.includes(plan.jellyfin_access_model) ? plan.jellyfin_access_model : 'concurrent_streams');
  return {
    jellyfin,
    stremio,
    accessModel,
    streams: source.streams ?? plan.streams ?? 1,
    jellyfinHouseholdNetworkLimit: source.jellyfinHouseholdNetworkLimit ?? plan.jellyfin_household_network_limit ?? 1,
    jellyfinHouseholdLeaseMinutes: source.jellyfinHouseholdLeaseMinutes ?? plan.jellyfin_household_lease_minutes ?? 240,
    stremioHouseholdLeaseMinutes: source.stremioHouseholdLeaseMinutes ?? plan.stremio_household_lease_minutes ?? 240,
    allowDownloads: body ? b(source.allowDownloads) : Boolean(plan.allow_downloads),
    allowVideoTranscoding: body ? b(source.allowVideoTranscoding) : Boolean(plan.allow_video_transcoding),
    allowAudioTranscoding: body ? b(source.allowAudioTranscoding) : Boolean(plan.allow_audio_transcoding),
    allowRemuxing: body ? b(source.allowRemuxing) : Boolean(plan.allow_remuxing),
    allowLiveTv: body ? b(source.allowLiveTv) : Boolean(plan.allow_live_tv),
    allowLiveTvManagement: body ? b(source.allowLiveTvManagement) : Boolean(plan.allow_live_tv_management),
    allowRemoteAccess: body ? b(source.allowRemoteAccess) : Boolean(plan.allow_remote_access)
  };
}
function toggle(name, label, value) {
  return `<label class="toggleRow"><input type="checkbox" name="${esc(name)}" ${checked(value)}><span><strong>${esc(label)}</strong></span></label>`;
}
function page(plan, req, error = '', body = null) {
  const v = values(plan, body);
  const household = v.jellyfin && v.accessModel === 'household_network';
  return `${planSubnav(plan, 'access')}${error ? `<div class="notice error">${esc(error)}</div>` : ''}${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}
  <section class="section"><div class="sectionHead"><div><h2>Access & playback</h2><div class="muted">Each product component keeps its own enforcement driver and household lease settings.</div></div></div>
  <form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/jellyfin" data-plan-access-editor><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
  ${v.jellyfin ? `<h3>Jellyfin access</h3><div class="formGrid"><div class="formGroup"><label>Playback enforcement</label><select class="input" name="jellyfinAccessModel" data-jellyfin-access-model><option value="concurrent_streams" ${selected('concurrent_streams', v.accessModel)}>Concurrent streams</option><option value="household_network" ${selected('household_network', v.accessModel)}>Household network / IP lease</option></select></div><div class="formGroup" data-jellyfin-stream-fields ${household ? 'hidden' : ''}><label>Concurrent streams</label><input class="input" type="number" min="1" max="50" name="streams" value="${esc(v.streams)}"><div class="inlineHelp">The existing stream monitor enforces this limit.</div></div><div class="formGroup" data-jellyfin-household-fields ${household ? '' : 'hidden'}><label>Simultaneous household networks</label><input class="input" type="number" min="1" max="10" name="jellyfinHouseholdNetworkLimit" value="${esc(v.jellyfinHouseholdNetworkLimit)}"><label>Network lease</label><div class="inputUnit"><input class="input" type="number" min="15" max="1440" name="jellyfinHouseholdLeaseMinutes" value="${esc(v.jellyfinHouseholdLeaseMinutes)}"><span>minutes</span></div><div class="inlineHelp">Same-network playback refreshes the lease. IPv6 devices sharing a /64 count as one network.</div></div></div>
  <h3>Jellyfin user policy</h3><div class="toggleGrid">${toggle('allowDownloads','Downloads',v.allowDownloads)}${toggle('allowVideoTranscoding','Video transcoding',v.allowVideoTranscoding)}${toggle('allowAudioTranscoding','Audio transcoding',v.allowAudioTranscoding)}${toggle('allowRemuxing','Remuxing',v.allowRemuxing)}${toggle('allowLiveTv','Live TV',v.allowLiveTv)}${toggle('allowLiveTvManagement','Live TV management',v.allowLiveTvManagement)}${toggle('allowRemoteAccess','Remote access',v.allowRemoteAccess)}</div>` : ''}
  ${v.stremio ? `<h3>Stremio household</h3><div class="securityNote standalone"><strong>1 active household network</strong><div class="subText">Unlimited Stremio playback inside the active household network. A second network is rejected until the lease expires.</div></div><div class="formGroup narrow"><label>Stremio network lease</label><div class="inputUnit"><input class="input" type="number" min="15" max="1440" name="stremioHouseholdLeaseMinutes" value="${esc(v.stremioHouseholdLeaseMinutes)}"><span>minutes</span></div></div>` : ''}
  <div class="operatorCallout statusInfo"><strong>Policy changes:</strong> saving clears active household leases for subscriptions on this plan so the new policy applies immediately. Existing customer access is reconciled in the background.</div>
  <div class="buttonRow"><button class="button" type="submit">Save access policy</button><a class="button secondary" href="/admin/plans/${esc(plan.id)}">Cancel</a></div></form></section>
  <script src="/js/admin-plan-access.js" defer></script>`;
}
function parse(plan, body) {
  const jellyfin = serviceIncludes(plan, 'jellyfin');
  const stremio = serviceIncludes(plan, 'stremio');
  const accessModel = jellyfin && ACCESS_MODELS.includes(body.jellyfinAccessModel) ? body.jellyfinAccessModel : 'concurrent_streams';
  return {
    jellyfin,
    stremio,
    accessModel,
    streams: jellyfin && accessModel === 'concurrent_streams' ? int(body.streams, 1, 50, 'Concurrent streams') : null,
    jellyfinHouseholdNetworkLimit: jellyfin && accessModel === 'household_network' ? int(body.jellyfinHouseholdNetworkLimit, 1, 10, 'Jellyfin household networks') : 1,
    jellyfinHouseholdLeaseMinutes: jellyfin && accessModel === 'household_network' ? int(body.jellyfinHouseholdLeaseMinutes, 15, 1440, 'Jellyfin household lease') : 240,
    stremioHouseholdLeaseMinutes: stremio ? int(body.stremioHouseholdLeaseMinutes, 15, 1440, 'Stremio household lease') : 240,
    allowDownloads: jellyfin && b(body.allowDownloads),
    allowVideoTranscoding: jellyfin && b(body.allowVideoTranscoding),
    allowAudioTranscoding: jellyfin && b(body.allowAudioTranscoding),
    allowRemuxing: jellyfin && b(body.allowRemuxing),
    allowLiveTv: jellyfin && b(body.allowLiveTv),
    allowLiveTvManagement: jellyfin && b(body.allowLiveTvManagement),
    allowRemoteAccess: jellyfin && b(body.allowRemoteAccess)
  };
}
async function clearPlanLeases(client, planId) {
  return client.query(
    `DELETE FROM access_network_leases
     WHERE subject_key IN (SELECT id::text FROM subscriptions WHERE plan_id=$1)
       AND scope IN ('jellyfin','stremio')`,
    [planId]
  );
}
async function save(plan, input, actorUserId) {
  return transaction(async client => {
    const count = await subscriberCount(plan.id);
    await client.query(
      `UPDATE plans SET
         jellyfin_access_model=$2,jellyfin_household_network_limit=$3,jellyfin_household_lease_minutes=$4,
         stremio_household_lease_minutes=$5,streams=$6,
         allow_downloads=$7,allow_video_transcoding=$8,allow_audio_transcoding=$9,allow_remuxing=$10,
         allow_live_tv=$11,allow_live_tv_management=$12,allow_remote_access=$13,updated_at=NOW()
       WHERE id=$1`,
      [plan.id, input.accessModel, input.jellyfinHouseholdNetworkLimit, input.jellyfinHouseholdLeaseMinutes, input.stremioHouseholdLeaseMinutes, input.streams,
       input.allowDownloads, input.allowVideoTranscoding, input.allowAudioTranscoding, input.allowRemuxing, input.allowLiveTv, input.allowLiveTvManagement, input.allowRemoteAccess]
    );
    await clearPlanLeases(client, plan.id);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.plan.access_policy.update','plan',$2,$3::jsonb)`,
      [actorUserId || null, plan.id, JSON.stringify({ ...input, activeSubscribers: count })]
    );
    return count;
  });
}

function createAdminPlanAccessRouter() {
  const router = express.Router();
  router.use('/admin/plans', gate, noStore);
  router.get('/admin/plans/:id/jellyfin', async (req, res, next) => {
    try {
      const plan = await loadPlan(req.params.id);
      if (!plan) return res.status(404).send('Plan not found');
      await runtimeSettings.ensureLoaded();
      return res.send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: plan.name, subtitle: 'Access & playback policy', body: page(plan, req), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
    } catch (error) { next(error); }
  });
  router.post('/admin/plans/:id/jellyfin', async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const plan = await loadPlan(req.params.id);
      if (!plan) return res.status(404).send('Plan not found');
      const input = parse(plan, req.body || {});
      const affected = await save(plan, input, req.session.authUserId);
      provisioning.queuePlanReconciliation(plan.id, req.session.authUserId).catch(error => console.error('Plan access reconciliation queue failed:', error.message));
      audit.log({ actorUserId: req.session.authUserId, action: 'admin.plan.access_policy.saved', entityType: 'plan', entityId: plan.id, metadata: { affected } }).catch(() => {});
      return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/jellyfin?message=${encodeURIComponent(`Access policy saved. ${affected} active subscription${affected === 1 ? '' : 's'} queued for reconciliation.`)}`);
    } catch (error) {
      try {
        const plan = await loadPlan(req.params.id);
        if (!plan) return res.status(404).send('Plan not found');
        return res.status(400).send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: plan.name, subtitle: 'Access & playback policy', body: page(plan, req, error.message, req.body || {}), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
      } catch (renderError) { next(renderError); }
    }
  });
  return router;
}

module.exports = { createAdminPlanAccessRouter, values, parse, page, clearPlanLeases, save };
