'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const runtimeSettings = require('./runtime-settings');
const { queuePlanReconciliation } = require('./bulk-jobs');
const { esc, layout } = require('./admin-html');

const ACCESS_MODELS = ['concurrent_streams', 'household_network'];
const accessPolicyWriteLimit = routeRateLimit.middleware({ scope: 'admin-plan-access-write', max: 30, windowSeconds: 60, reason: 'admin_plan_access_write' });

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
    ['overview', `/admin/plans/${id}/edit`, 'Overview'],
    ['access', `/admin/plans/${id}/access`, 'Access'],
    ['commerce', `/admin/plans/${id}/commerce`, 'Pricing']
  ];
  if (serviceIncludes(plan, 'jellyfin')) {
    links.push(['libraries', `/admin/plans/${id}/libraries`, 'Libraries'], ['placement', `/admin/plans/${id}/placement`, 'Servers']);
  }
  if (serviceIncludes(plan, 'stremio')) links.push(['stremio', `/admin/plans/${id}/stremio`, 'Stremio sources']);
  return `<div class="buttonRow planSubnav">${links.map(([key, href, label]) => `<a class="button ${key === active ? '' : 'secondary'}" href="${href}">${esc(label)}</a>`).join('')}</div>`;
}
async function loadPlan(id) {
  const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
  return result.rows[0] || null;
}
async function subscriberCount(planId, client = null) {
  const runner = client || { query };
  const result = await runner.query(
    `SELECT COUNT(DISTINCT customer_id)::int count FROM subscriptions
     WHERE plan_id=$1 AND superseded_by IS NULL
       AND status IN ('active','trialing','past_due','paused')
       AND starts_at<=NOW() AND current_period_end>NOW()`,
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
    allowRemoteAccess: body ? b(source.allowRemoteAccess) : Boolean(plan.allow_remote_access),
    allow4k: body ? b(source.allow4k) : Boolean(plan.allow_4k),
    allowSubtitleEditing: body ? b(source.allowSubtitleEditing) : Boolean(plan.allow_subtitle_editing)
  };
}
function toggle(name, label, value) {
  return `<label class="toggleRow"><input type="checkbox" name="${esc(name)}" ${checked(value)}><span><strong>${esc(label)}</strong></span></label>`;
}
function impactConfirmation(plan, count, body) {
  if (!count) return '';
  return `<div class="notice warn"><strong>Impact preview:</strong> this policy currently affects ${esc(count)} live customer entitlement${count === 1 ? '' : 's'}. Type <strong>${esc(plan.code)}</strong> to confirm the change.</div><div class="formGroup"><label for="plan-access-impact-confirmation">Impact confirmation</label><input id="plan-access-impact-confirmation" class="input" name="impactConfirmation" autocomplete="off" required value="${esc(body?.impactConfirmation || '')}" placeholder="${esc(plan.code)}"></div>`;
}
async function page(plan, req, error = '', body = null) {
  const v = values(plan, body);
  const household = v.jellyfin && v.accessModel === 'household_network';
  const affected = await subscriberCount(plan.id);
  return `${planSubnav(plan, 'access')}${error ? `<div class="notice error">${esc(error)}</div>` : ''}${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}
  <section class="section"><div class="sectionHead"><div><h2>Access & playback</h2><div class="muted">Concurrent streams are independent and may be unlimited. The legacy household lease can optionally run alongside them.</div></div><span class="muted">${affected} live entitlement${affected === 1 ? '' : 's'}</span></div>
  <form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/access" data-plan-access-editor><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
  ${v.jellyfin ? `<h3>Jellyfin access</h3><div class="formGrid"><div class="formGroup"><label for="jellyfin-access-model">Legacy household lease</label><select id="jellyfin-access-model" class="input" name="jellyfinAccessModel" data-jellyfin-access-model><option value="concurrent_streams" ${selected('concurrent_streams', v.accessModel)}>Off</option><option value="household_network" ${selected('household_network', v.accessModel)}>Also enforce household network lease</option></select><div class="inlineHelp">This legacy network lease is optional. Concurrent streams below remain independently configured in either mode; the newer active-IP limit is configured separately in Advanced Settings.</div></div><div class="formGroup" data-jellyfin-stream-fields><label for="jellyfin-concurrent-streams">Concurrent streams</label><input id="jellyfin-concurrent-streams" class="input" type="number" min="0" max="50" name="streams" value="${esc(v.streams)}"><div class="inlineHelp">0 = unlimited. Maximum simultaneous playing sessions, independent of IP and registered-device limits.</div></div><div class="formGroup" data-jellyfin-household-fields ${household ? '' : 'hidden'}><label for="jellyfin-household-network-limit">Simultaneous household networks</label><input id="jellyfin-household-network-limit" class="input" type="number" min="1" max="10" name="jellyfinHouseholdNetworkLimit" value="${esc(v.jellyfinHouseholdNetworkLimit)}"><label for="jellyfin-household-lease-minutes">Network lease</label><div class="inputUnit"><input id="jellyfin-household-lease-minutes" class="input" type="number" min="15" max="1440" name="jellyfinHouseholdLeaseMinutes" value="${esc(v.jellyfinHouseholdLeaseMinutes)}"><span>minutes</span></div><div class="inlineHelp">Same-network playback refreshes the lease. IPv6 devices sharing a /64 count as one network.</div></div></div>
  <h3>Jellyfin user policy</h3><div class="toggleGrid">${toggle('allowDownloads','Downloads',v.allowDownloads)}${toggle('allowVideoTranscoding','Video transcoding',v.allowVideoTranscoding)}${toggle('allowAudioTranscoding','Audio transcoding',v.allowAudioTranscoding)}${toggle('allowRemuxing','Remuxing',v.allowRemuxing)}${toggle('allowLiveTv','Live TV',v.allowLiveTv)}${toggle('allowLiveTvManagement','Live TV management',v.allowLiveTvManagement)}${toggle('allowRemoteAccess','Remote access',v.allowRemoteAccess)}${toggle('allow4k','4K catalogue flag',v.allow4k)}${toggle('allowSubtitleEditing','Edit subtitles',v.allowSubtitleEditing)}</div>` : ''}
  ${v.stremio ? `<h3>Stremio household</h3><div class="securityNote standalone"><strong>1 household slot (IPv4 + IPv6 /64)</strong><div class="subText">Unlimited Stremio playback inside the household slot: one IPv4 address and one IPv6 /64 prefix are allowed before another same-family network is rejected.</div></div><div class="formGroup narrow"><label for="stremio-household-lease-minutes">Stremio network lease</label><div class="inputUnit"><input id="stremio-household-lease-minutes" class="input" type="number" min="15" max="1440" name="stremioHouseholdLeaseMinutes" value="${esc(v.stremioHouseholdLeaseMinutes)}"><span>minutes</span></div><div class="inlineHelp">This lease refreshes on playback and can be reset from the customer or admin Stremio controls.</div></div>` : ''}
  <div class="operatorCallout statusInfo"><strong>Policy changes:</strong> saving clears active household leases for subscriptions on this plan so the new policy applies immediately. Jellyfin customers are reconciled through the existing bounded background-job queue.</div>
  ${impactConfirmation(plan, affected, body)}
  <div class="buttonRow"><button class="button" type="submit">Save access policy</button><a class="button secondary" href="/admin/plans/${esc(plan.id)}/edit">Cancel</a></div></form></section>
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
    streams: jellyfin ? int(body.streams, 0, 50, 'Concurrent streams') : (Number.isInteger(Number(plan.streams)) ? Number(plan.streams) : 1),
    jellyfinHouseholdNetworkLimit: jellyfin && accessModel === 'household_network' ? int(body.jellyfinHouseholdNetworkLimit, 1, 10, 'Jellyfin household networks') : 1,
    jellyfinHouseholdLeaseMinutes: jellyfin && accessModel === 'household_network' ? int(body.jellyfinHouseholdLeaseMinutes, 15, 1440, 'Jellyfin household lease') : 240,
    stremioHouseholdLeaseMinutes: stremio ? int(body.stremioHouseholdLeaseMinutes, 15, 1440, 'Stremio household lease') : 240,
    allowDownloads: jellyfin ? b(body.allowDownloads) : Boolean(plan.allow_downloads),
    allowVideoTranscoding: jellyfin ? b(body.allowVideoTranscoding) : Boolean(plan.allow_video_transcoding),
    allowAudioTranscoding: jellyfin ? b(body.allowAudioTranscoding) : Boolean(plan.allow_audio_transcoding),
    allowRemuxing: jellyfin ? b(body.allowRemuxing) : Boolean(plan.allow_remuxing),
    allowLiveTv: jellyfin ? b(body.allowLiveTv) : Boolean(plan.allow_live_tv),
    allowLiveTvManagement: jellyfin ? b(body.allowLiveTvManagement) : Boolean(plan.allow_live_tv_management),
    allowRemoteAccess: jellyfin ? b(body.allowRemoteAccess) : Boolean(plan.allow_remote_access),
    allow4k: jellyfin ? b(body.allow4k) : Boolean(plan.allow_4k),
    allowSubtitleEditing: jellyfin ? b(body.allowSubtitleEditing) : Boolean(plan.allow_subtitle_editing)
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
    const count = await subscriberCount(plan.id, client);
    await client.query(
      `UPDATE plans SET
         jellyfin_access_model=$2,jellyfin_household_network_limit=$3,jellyfin_household_lease_minutes=$4,
         stremio_household_lease_minutes=$5,streams=$6,
         allow_downloads=$7,allow_video_transcoding=$8,allow_audio_transcoding=$9,allow_remuxing=$10,
         allow_live_tv=$11,allow_live_tv_management=$12,allow_remote_access=$13,allow_4k=$14,
         allow_subtitle_editing=$15,updated_at=NOW()
       WHERE id=$1`,
      [plan.id, input.accessModel, input.jellyfinHouseholdNetworkLimit, input.jellyfinHouseholdLeaseMinutes, input.stremioHouseholdLeaseMinutes, input.streams,
       input.allowDownloads, input.allowVideoTranscoding, input.allowAudioTranscoding, input.allowRemuxing, input.allowLiveTv, input.allowLiveTvManagement, input.allowRemoteAccess, input.allow4k,
       input.allowSubtitleEditing]
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
  const paths = ['/admin/plans/:id/access', '/admin/plans/:id/jellyfin'];
  router.get(paths, async (req, res, next) => {
    try {
      const plan = await loadPlan(req.params.id);
      if (!plan) return res.status(404).send('Plan not found');
      await runtimeSettings.ensureLoaded();
      return res.send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: plan.name, subtitle: 'Access & playback policy', body: await page(plan, req), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
    } catch (error) { next(error); }
  });
  router.post(paths, accessPolicyWriteLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const plan = await loadPlan(req.params.id);
      if (!plan) return res.status(404).send('Plan not found');
      const affected = await subscriberCount(plan.id);
      if (affected > 0 && String(req.body?.impactConfirmation || '').trim() !== String(plan.code)) {
        throw new Error(`Type ${plan.code} exactly to confirm the impact on ${affected} live customer entitlement${affected === 1 ? '' : 's'}.`);
      }
      const input = parse(plan, req.body || {});
      await save(plan, input, req.session.authUserId);
      const job = serviceIncludes(plan, 'jellyfin') ? await queuePlanReconciliation(plan.id, req.session.authUserId) : null;
      if (job) return res.redirect(`/admin/jobs/${encodeURIComponent(job.id)}?message=${encodeURIComponent('Access policy saved; affected Jellyfin customers were queued for update.')}`);
      return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/access?message=${encodeURIComponent('Access policy saved.')}`);
    } catch (error) {
      try {
        const plan = await loadPlan(req.params.id);
        if (!plan) return res.status(404).send('Plan not found');
        return res.status(400).send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: plan.name, subtitle: 'Access & playback policy', body: await page(plan, req, error.message, req.body || {}), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
      } catch (renderError) { next(renderError); }
    }
  });
  return router;
}

module.exports = { createAdminPlanAccessRouter, values, parse, page, clearPlanLeases, save, subscriberCount };
