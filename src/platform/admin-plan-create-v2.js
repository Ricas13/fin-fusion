'use strict';

const express = require('express');
const { transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const runtimeSettings = require('./runtime-settings');
const reportingCurrency = require('./reporting-currency');
const planPricing = require('../payments/plan-pricing');
const planPolicy = require('../entitlements/plan-lifecycle-policy');
const { esc, layout } = require('./admin-html');

const BILLING = { trial: { label: 'Trial', days: 1 }, month: { label: 'Monthly', days: 30 }, '6_months': { label: '6 months', days: 183 }, year: { label: 'Yearly', days: 365 }, custom: { label: 'Custom duration', days: null } };
const SERVICE_TYPES = ['jellyfin', 'stremio', 'bundle'];
const JELLYFIN_ACCESS_MODELS = ['concurrent_streams', 'household_network'];
const CURRENCIES = reportingCurrency.CURRENCIES;
const planCreateWriteLimit = routeRateLimit.middleware({ scope: 'admin-plan-create', max: 20, windowSeconds: 60, reason: 'admin_plan_create' });

function gate(req, res, next) { return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired'); }
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store, private, max-age=0'); res.setHeader('Pragma', 'no-cache'); next(); }
function b(v) { return v === true || ['on', 'true', '1', 'yes'].includes(String(v || '').toLowerCase()); }
function text(v, max) { return String(v || '').trim().slice(0, max); }
function int(v, min, max, label) { const raw = String(v ?? '').trim(), n = Number.parseInt(raw, 10); if (!Number.isInteger(n) || String(n) !== raw || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`); return n; }
function money(v) { const raw = String(v ?? '').trim(); if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a valid non-negative price with no more than two decimal places.'); const n = Number(raw); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Price must be between 0 and 100,000.'); return Math.round(n * 100); }
function libraryNames(v) { return [...new Set(String(v || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(x => x.slice(0, 200)))].slice(0, 500); }
function selected(a, b) { return a === b ? 'selected' : ''; }
function checked(v) { return v ? 'checked' : ''; }
function notice(req) { return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`; }
function toggle(name, label, value, help = '') { return `<label class="toggleRow"><input type="checkbox" name="${esc(name)}" ${checked(value)}><span><strong>${esc(label)}</strong>${help ? `<small class="muted">${esc(help)}</small>` : ''}</span></label>`; }

function parse(body = {}, forcedCurrency = null) {
  const code = text(body.code, 50).toLowerCase(), name = text(body.name, 80), description = text(body.description, 500);
  if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)) throw new Error('Code must be 2–50 characters using lowercase letters, numbers and hyphens.');
  if (!name) throw new Error('Enter a plan name.');
  const serviceType = SERVICE_TYPES.includes(body.serviceType) ? body.serviceType : 'jellyfin';
  const audience = 'direct';
  const billing = Object.prototype.hasOwnProperty.call(BILLING, body.billingInterval) ? body.billingInterval : 'month';
  const priceMinor = money(body.price);
  const currency = text(forcedCurrency || body.currency || 'GBP', 3).toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('Currency must be GBP, USD or EUR.');
  const duration = BILLING[billing].days ?? int(body.durationDays, 1, 3650, 'Duration');
  const capacityLimit = int(body.capacityLimit, 0, 1000000, 'Available slots');
  const isAddon = b(body.isAddon);
  if (isAddon && serviceType !== 'stremio') throw new Error('Independent add-ons must be Stremio-only. Use a bundle for Jellyfin + Stremio.');
  const jellyfin = ['jellyfin', 'bundle'].includes(serviceType);
  const stremio = ['stremio', 'bundle'].includes(serviceType);
  const jellyfinAccessModel = jellyfin && JELLYFIN_ACCESS_MODELS.includes(body.jellyfinAccessModel) ? body.jellyfinAccessModel : 'concurrent_streams';
  const streams = serviceType === 'stremio' ? 1 : (jellyfinAccessModel === 'household_network' ? null : int(body.streams, 1, 50, 'Jellyfin concurrent streams'));
  const jellyfinHouseholdNetworkLimit = jellyfinAccessModel === 'household_network' ? int(body.jellyfinHouseholdNetworkLimit ?? '1', 1, 10, 'Jellyfin household networks') : 1;
  const jellyfinHouseholdLeaseMinutes = jellyfinAccessModel === 'household_network' ? int(body.jellyfinHouseholdLeaseMinutes ?? '240', 15, 1440, 'Jellyfin household lease') : 240;
  const stremioHouseholdLeaseMinutes = stremio ? int(body.stremioHouseholdLeaseMinutes ?? '240', 15, 1440, 'Stremio household lease') : 240;
  const libraryMode = ['all', 'include', 'exclude'].includes(body.libraryAccessMode) ? body.libraryAccessMode : 'all';
  const libraries = libraryNames(body.libraryNames);
  if (jellyfin && libraryMode !== 'all' && !libraries.length) throw new Error('Enter at least one library name when using Include only or Exclude selected libraries.');
  const plan = {
    code, name, description, serviceType, audience, billing, duration, priceMinor, currency, capacityLimit, streams, isAddon,
    jellyfinAccessModel, jellyfinHouseholdNetworkLimit, jellyfinHouseholdLeaseMinutes, stremioHouseholdLeaseMinutes,
    serverClass: ['premium', 'free', 'custom'].includes(body.serverClass) ? body.serverClass : 'premium',
    visible: b(body.visible), active: b(body.active), downloads: jellyfin && b(body.allowDownloads), video: jellyfin && b(body.allowVideoTranscoding),
    audio: jellyfin && b(body.allowAudioTranscoding), remux: jellyfin && b(body.allowRemuxing), live: jellyfin && b(body.allowLiveTv),
    liveManagement: jellyfin && b(body.allowLiveTvManagement), remote: jellyfin && b(body.allowRemoteAccess), fourk: jellyfin && b(body.allow4k),
    libraryMode: jellyfin ? libraryMode : 'all', libraries: jellyfin ? libraries : []
  };
  plan.inactivityPolicy = planPolicy.validateForPlan(
    { price_minor: priceMinor, billing_interval: billing, service_type: serviceType },
    { enabled: b(body.inactivityEnabled), dryRun: b(body.inactivityDryRun), noPlaybackDays: body.noPlaybackDays, minimumPlaybackMinutes: body.minimumPlaybackMinutes, playbackWindowDays: body.playbackWindowDays, minimumObservationHours: body.minimumObservationHours }
  );
  return plan;
}

async function create(plan, actorUserId) {
  return transaction(async client => {
    const nextOrder = Number((await client.query(`SELECT COALESCE(MAX(sort_order),0)+10 AS n FROM plans`)).rows[0]?.n || 10);
    const result = await client.query(
      `INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,is_addon,server_class,visible,active,sort_order,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,stremio_household_lease_minutes,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names,inactivity_policy)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::text[],$31::jsonb) RETURNING *`,
      [plan.code, plan.name, plan.description, plan.serviceType, plan.audience, plan.billing, plan.duration, plan.priceMinor, plan.currency, plan.capacityLimit, plan.isAddon, plan.serverClass, plan.visible, plan.active, nextOrder, plan.jellyfinAccessModel, plan.jellyfinHouseholdNetworkLimit, plan.jellyfinHouseholdLeaseMinutes, plan.stremioHouseholdLeaseMinutes, plan.streams, plan.downloads, plan.video, plan.audio, plan.remux, plan.live, plan.liveManagement, plan.remote, plan.fourk, plan.libraryMode, plan.libraries, JSON.stringify(plan.inactivityPolicy)]
    );
    await planPricing.setPrice(client, result.rows[0].id, { currency: plan.currency, priceMinor: plan.priceMinor, active: true, isDefault: true });
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.create','plan',$2,$3::jsonb)`,
      [actorUserId, result.rows[0].id, JSON.stringify({ code: plan.code, serviceType: plan.serviceType, audience: 'direct', currency: plan.currency, priceMinor: plan.priceMinor, capacityLimit: plan.capacityLimit, jellyfinAccessModel: plan.jellyfinAccessModel, streams: plan.streams, jellyfinHouseholdNetworkLimit: plan.jellyfinHouseholdNetworkLimit, jellyfinHouseholdLeaseMinutes: plan.jellyfinHouseholdLeaseMinutes, stremioHouseholdLeaseMinutes: plan.stremioHouseholdLeaseMinutes, jellyfinPolicy: { downloads: plan.downloads, videoTranscoding: plan.video, audioTranscoding: plan.audio, remux: plan.remux, liveTv: plan.live, liveTvManagement: plan.liveManagement, remoteAccess: plan.remote, allow4k: plan.fourk, libraryAccessMode: plan.libraryMode, libraryNames: plan.libraries }, inactivityPolicy: plan.inactivityPolicy })]
    );
    return result.rows[0];
  });
}

function values(req, input = {}, currency = 'GBP') {
  const submitted = Boolean(input.__submitted);
  const service = SERVICE_TYPES.includes(input.serviceType) ? input.serviceType : (SERVICE_TYPES.includes(String(req.query?.type || '')) ? String(req.query.type) : 'jellyfin');
  const billing = Object.prototype.hasOwnProperty.call(BILLING, input.billingInterval) ? input.billingInterval : 'month';
  const portalCurrency = CURRENCIES.includes(text(currency, 3).toUpperCase()) ? text(currency, 3).toUpperCase() : 'GBP';
  return {
    ...input,
    serviceType: service,
    billingInterval: billing,
    currency: portalCurrency,
    price: input.price ?? '0.00',
    durationDays: input.durationDays ?? BILLING[billing].days ?? 30,
    capacityLimit: input.capacityLimit ?? '0',
    jellyfinAccessModel: JELLYFIN_ACCESS_MODELS.includes(input.jellyfinAccessModel) ? input.jellyfinAccessModel : 'concurrent_streams',
    streams: input.streams ?? '1',
    jellyfinHouseholdNetworkLimit: input.jellyfinHouseholdNetworkLimit ?? '1',
    jellyfinHouseholdLeaseMinutes: input.jellyfinHouseholdLeaseMinutes ?? '240',
    stremioHouseholdLeaseMinutes: input.stremioHouseholdLeaseMinutes ?? '240',
    serverClass: input.serverClass || 'premium',
    libraryAccessMode: input.libraryAccessMode || 'all',
    playbackWindowDays: input.playbackWindowDays ?? 7,
    minimumObservationHours: input.minimumObservationHours ?? 24,
    visible: submitted ? b(input.visible) : true,
    active: submitted ? b(input.active) : true,
    allowAudioTranscoding: submitted ? b(input.allowAudioTranscoding) : true,
    allowRemoteAccess: submitted ? b(input.allowRemoteAccess) : true,
    allow4k: submitted ? b(input.allow4k) : true,
    inactivityDryRun: submitted ? b(input.inactivityDryRun) : true
  };
}

function form(req, input = {}, error = '', currency = 'GBP') {
  const v = values(req, input, currency);
  const jellyfin = ['jellyfin', 'bundle'].includes(v.serviceType);
  const stremio = ['stremio', 'bundle'].includes(v.serviceType);
  const householdJellyfin = jellyfin && v.jellyfinAccessModel === 'household_network';
  const freeNonTrial = Number(v.price || 0) === 0 && v.billingInterval !== 'trial' && jellyfin;
  return `${notice(req)}${error ? `<div class="notice error">${esc(error)}</div>` : ''}<section class="section"><div class="sectionHead"><div><h2>New customer plan</h2><div class="muted">One familiar flow for every direct product: product → pricing → availability → delivery → playback → policy → libraries.</div></div></div><form class="formPanel" method="post" action="/admin/plans" data-plan-create-v2><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="__submitted" value="1">
  <h3>Product</h3><div class="formGrid"><div class="formGroup"><label>Plan type</label><select class="input" name="serviceType" data-plan-service>${[['jellyfin','Jellyfin access'],['stremio','Stremio only'],['bundle','Jellyfin + Stremio bundle']].map(([x,l])=>`<option value="${x}" ${selected(x,v.serviceType)}>${l}</option>`).join('')}</select></div><div class="formGroup"><label>Customer audience</label><div class="securityNote standalone"><strong>Direct customers</strong><div class="subText">Plans created here are sold directly by CAPTAiNFiN to customer accounts.</div></div></div><div class="formGroup"><label>Optional add-on</label><label class="toggleRow"><input type="checkbox" name="isAddon" ${checked(b(v.isAddon))}><span>Offer as an independent add-on <small class="muted">Stremio-only; use Bundle when Jellyfin is included.</small></span></label></div></div>
  <div class="formGrid"><div class="formGroup"><label>Code</label><input class="input" name="code" required pattern="[a-z0-9][a-z0-9-]{1,49}" maxlength="50" placeholder="monthly-access" value="${esc(v.code||'')}"></div><div class="formGroup"><label>Name</label><input class="input" name="name" required maxlength="80" placeholder="Monthly Access" value="${esc(v.name||'')}"></div></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(v.description||'')}</textarea></div>
  <h3>Commercial terms & availability</h3><div class="formGrid"><div class="formGroup"><label>Price</label><input class="input" type="number" step="0.01" min="0" max="100000" name="price" required value="${esc(v.price)}" data-plan-price><div class="inlineHelp">All plans use the portal currency configured under Settings → Portal currency.</div></div><div class="formGroup"><label>Currency</label><div class="securityNote standalone"><strong>${esc(v.currency)}</strong><div class="subText">Portal-wide setting · not configurable per plan.</div></div></div><div class="formGroup"><label>Available slots</label><input class="input" type="number" min="0" max="1000000" name="capacityLimit" required value="${esc(v.capacityLimit)}"><div class="inlineHelp">New plans start at 0 so you can finish setup before opening sales. Increase this from Availability when you are ready to accept customers.</div></div></div><div class="operatorCallout statusInfo"><strong>Storefront position:</strong> new plans are added after the existing cards automatically. Reorder them later from Plans → Storefront order; there is no second numeric order control here.</div>
  <div class="formGrid"><div class="formGroup"><label>Billing / access frequency</label><select class="input" name="billingInterval" data-plan-frequency>${Object.entries(BILLING).map(([x,d])=>`<option value="${x}" data-days="${d.days??''}" ${selected(x,v.billingInterval)}>${esc(d.label)}</option>`).join('')}</select></div><div class="formGroup"><label>Duration (days)</label><input class="input" type="number" name="durationDays" min="1" max="3650" required value="${esc(v.durationDays)}" data-plan-duration></div><div class="formGroup" data-jellyfin-only><label>Server class</label><select class="input" name="serverClass">${['premium','free','custom'].map(x=>`<option value="${x}" ${selected(x,v.serverClass)}>${x}</option>`).join('')}</select><div class="inlineHelp">Premium plans target Premium servers, Free plans target Free servers, and Custom uses explicit placement rules.</div></div></div>
  <div data-jellyfin-only ${jellyfin?'':'hidden'}><h3>Jellyfin access model</h3><div class="formGrid"><div class="formGroup"><label>Playback enforcement</label><select class="input" name="jellyfinAccessModel" data-jellyfin-access-model><option value="concurrent_streams" ${selected('concurrent_streams',v.jellyfinAccessModel)}>Concurrent streams</option><option value="household_network" ${selected('household_network',v.jellyfinAccessModel)}>Household network / IP lease</option></select><div class="inlineHelp">Choose whether Jellyfin is limited by simultaneous streams or by active household networks.</div></div><div class="formGroup" data-jellyfin-stream-fields ${householdJellyfin?'hidden':''}><label>Jellyfin concurrent streams</label><input class="input" type="number" name="streams" min="1" max="50" value="${esc(v.streams)}"><div class="inlineHelp">Only used by the concurrent-stream driver.</div></div><div class="formGroup" data-jellyfin-household-fields ${householdJellyfin?'':'hidden'}><label>Simultaneous household networks</label><input class="input" type="number" name="jellyfinHouseholdNetworkLimit" min="1" max="10" value="${esc(v.jellyfinHouseholdNetworkLimit)}"><div class="inlineHelp">Usually 1. Devices sharing the same public IPv4 or IPv6 /64 count as one household network.</div><label>Jellyfin network lease</label><div class="inputUnit"><input class="input" type="number" name="jellyfinHouseholdLeaseMinutes" min="15" max="1440" value="${esc(v.jellyfinHouseholdLeaseMinutes)}"><span>minutes</span></div><div class="inlineHelp">Playback from the same household refreshes this lease.</div></div></div></div>
  <div data-stremio-household ${stremio?'':'hidden'}><h3>Stremio access</h3><div class="securityNote standalone"><strong>1 Stremio household per subscription</strong><div class="subText">The installation may stream freely inside its active household network. A second network is rejected while the household lease remains active.</div></div><div class="formGroup narrow"><label>Stremio network lease</label><div class="inputUnit"><input class="input" type="number" name="stremioHouseholdLeaseMinutes" min="15" max="1440" value="${esc(v.stremioHouseholdLeaseMinutes)}"><span>minutes</span></div><div class="inlineHelp">Default 240 minutes (4 hours). This is independent from the Jellyfin component in a bundle.</div></div></div>
  <div data-jellyfin-policy ${jellyfin?'':'hidden'}><h3>Jellyfin user policy</h3><div class="toggleGrid">${toggle('allowDownloads','Downloads',b(v.allowDownloads))}${toggle('allowVideoTranscoding','Video transcoding',b(v.allowVideoTranscoding))}${toggle('allowAudioTranscoding','Audio transcoding',b(v.allowAudioTranscoding))}${toggle('allowRemuxing','Remuxing',b(v.allowRemuxing))}${toggle('allowLiveTv','Live TV',b(v.allowLiveTv))}${toggle('allowLiveTvManagement','Live TV recording / management',b(v.allowLiveTvManagement))}${toggle('allowRemoteAccess','Remote access',b(v.allowRemoteAccess))}${toggle('allow4k','4K catalogue flag',b(v.allow4k),'Use library access to enforce 4K-only library visibility; Jellyfin has no generic per-user resolution switch.')}</div><div class="operatorCallout statusInfo"><strong>Subtitles:</strong> Jellyfin does not expose a separate per-user subtitle permission in the policy model used here. Subtitle playback follows the client, media and transcoding/remux permissions.</div>
  <h3>Jellyfin libraries</h3><div class="formGrid"><div class="formGroup"><label>Library access</label><select class="input" name="libraryAccessMode"><option value="all" ${selected('all',v.libraryAccessMode)}>All libraries</option><option value="include" ${selected('include',v.libraryAccessMode)}>Only named libraries</option><option value="exclude" ${selected('exclude',v.libraryAccessMode)}>All except named libraries</option></select></div><div class="formGroup"><label>Library names</label><textarea class="input" name="libraryNames" rows="4" placeholder="Movies\nTV\n4K Movies">${esc(v.libraryNames||'')}</textarea><div class="inlineHelp">One per line or comma-separated. You can refine live-discovered libraries after creation from the Libraries tab.</div></div></div></div>
  <div data-free-lifecycle ${freeNonTrial?'':'hidden'}><h3>Free-plan Jellyfin usage rules <span class="muted">(optional)</span></h3><div class="operatorCallout"><strong>Jellyfin only:</strong> matching these rules disables Jellyfin access. The CAPTAiNFiN portal customer is never deleted/deactivated.</div><div class="formGrid"><div class="formGroup"><label>No playback for</label><div class="inputUnit"><input class="input" type="number" name="noPlaybackDays" min="1" max="3650" value="${esc(v.noPlaybackDays||'')}" placeholder="7"><span>days</span></div></div><div class="formGroup"><label>Minimum playback</label><div class="inputUnit"><input class="input" type="number" name="minimumPlaybackMinutes" min="1" max="1000000" value="${esc(v.minimumPlaybackMinutes||'')}" placeholder="30"><span>minutes</span></div><label>Within</label><div class="inputUnit"><input class="input" type="number" name="playbackWindowDays" min="1" max="365" value="${esc(v.playbackWindowDays)}"><span>days</span></div></div><div class="formGroup"><label>Minimum observation</label><div class="inputUnit"><input class="input" type="number" name="minimumObservationHours" min="1" max="2160" value="${esc(v.minimumObservationHours)}"><span>hours</span></div></div></div><div class="toggleGrid">${toggle('inactivityEnabled','Enable usage rule',b(v.inactivityEnabled))}${toggle('inactivityDryRun','Dry run only',b(v.inactivityDryRun),'Recommended until the evidence preview looks right.')}</div></div>
  <div class="toggleGrid">${toggle('visible','Visible in applicable storefront',v.visible)}${toggle('active','Active',v.active)}</div><div class="buttonRow"><button class="button" type="submit">Create plan</button><a class="button secondary" href="/admin/plans">Cancel</a></div></form></section><script src="/js/admin-plan-create-v2.js" defer></script>`;
}

function createAdminPlanCreateV2Router() {
  const router = express.Router();
  router.use('/admin/plans', gate, noStore);
  router.get('/admin/plans/new', async (req, res, next) => {
    try {
      await runtimeSettings.ensureLoaded();
      const currency = (await reportingCurrency.get()).currency;
      return res.send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: 'New customer plan', subtitle: `Product, pricing (${currency}), availability, delivery, policy and libraries`, body: form(req, {}, '', currency), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
    } catch (error) { next(error); }
  });
  router.post('/admin/plans', planCreateWriteLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    let currency = 'GBP';
    try {
      currency = (await reportingCurrency.get()).currency;
      const input = parse(req.body, currency);
      const created = await create(input, req.session.authUserId);
      const nextPath = ['jellyfin', 'bundle'].includes(input.serviceType) ? `/admin/plans/${created.id}/edit` : `/admin/plans/${created.id}/delivery`;
      return res.redirect(`${nextPath}?message=${encodeURIComponent(`Plan created in ${currency}. Availability remains closed until you open plan slots.`)}`);
    } catch (error) {
      if (error?.code === '23505') error = new Error('That plan code already exists.');
      try {
        return res.status(400).send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: 'New customer plan', subtitle: `Product, pricing (${currency}), availability, delivery, policy and libraries`, body: form(req, req.body, error.message, currency), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
      } catch (renderError) { return next(renderError); }
    }
  });
  return router;
}

module.exports = { createAdminPlanCreateV2Router, parse, create, form };
