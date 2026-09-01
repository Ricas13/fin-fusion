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
const SERVICE_TYPES = ['jellyfin', 'stremio'];
const PLAN_KINDS = ['free_jellyfin', 'paid_jellyfin', 'stremio'];
const JELLYFIN_ACCESS_MODELS = ['concurrent_streams', 'household_network'];
const STREMIO_REPLACEMENT_POLICIES = ['auto_inactive', 'customer_cooldown'];
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
function kindFromLegacy(body = {}) {
  if (PLAN_KINDS.includes(body.planKind)) return body.planKind;
  if (String(body.serviceType || '').toLowerCase() === 'stremio') return 'stremio';
  const price = Number(body.price);
  const billing = String(body.billingInterval || 'month');
  return Number.isFinite(price) && price === 0 && billing !== 'trial' && String(body.serverClass || '').toLowerCase() === 'free' ? 'free_jellyfin' : 'paid_jellyfin';
}
function serviceForKind(kind) { return kind === 'stremio' ? 'stremio' : 'jellyfin'; }

function parse(body = {}, forcedCurrency = null) {
  const code = text(body.code, 50).toLowerCase(), name = text(body.name, 80), description = text(body.description, 500);
  if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)) throw new Error('Code must be 2–50 characters using lowercase letters, numbers and hyphens.');
  if (!name) throw new Error('Enter a plan name.');
  const legacyServiceType = text(body.serviceType, 20).toLowerCase();
  if (!body.planKind && legacyServiceType && !SERVICE_TYPES.includes(legacyServiceType)) throw new Error('Choose Jellyfin or Stremio as the plan type.');
  const planKind = kindFromLegacy(body);
  if (!PLAN_KINDS.includes(planKind)) throw new Error('Choose Free Jellyfin, Paid Jellyfin or Stremio as the plan type.');
  const serviceType = serviceForKind(planKind);
  if (!SERVICE_TYPES.includes(serviceType)) throw new Error('Choose Jellyfin or Stremio as the plan type.');
  const freeJellyfin = planKind === 'free_jellyfin';
  const jellyfin = serviceType === 'jellyfin';
  const stremio = serviceType === 'stremio';
  const audience = 'direct';
  const billing = freeJellyfin ? 'month' : (Object.prototype.hasOwnProperty.call(BILLING, body.billingInterval) ? body.billingInterval : 'month');
  const priceMinor = freeJellyfin ? 0 : money(body.price);
  const currency = text(forcedCurrency || body.currency || 'GBP', 3).toUpperCase();
  if (!CURRENCIES.includes(currency)) throw new Error('Currency must be GBP, USD or EUR.');
  const duration = freeJellyfin ? 30 : (BILLING[billing].days ?? int(body.durationDays, 1, 3650, 'Duration'));
  const capacityLimit = int(body.capacityLimit, 0, 1000000, 'Available slots');
  if (b(body.isAddon)) throw new Error('Add-ons are retired. Create a standalone Stremio plan instead.');
  const isAddon = false;
  const jellyfinAccessModel = jellyfin && JELLYFIN_ACCESS_MODELS.includes(body.jellyfinAccessModel) ? body.jellyfinAccessModel : 'concurrent_streams';
  const streams = stremio ? 1 : int(body.streams ?? '1', 0, 50, 'Jellyfin concurrent streams');
  const jellyfinHouseholdNetworkLimit = jellyfinAccessModel === 'household_network' ? int(body.jellyfinHouseholdNetworkLimit ?? '1', 1, 10, 'Jellyfin household connections') : 1;
  const jellyfinHouseholdLeaseMinutes = jellyfinAccessModel === 'household_network' ? int(body.jellyfinHouseholdLeaseMinutes ?? '240', 15, 1440, 'Jellyfin household lease') : 240;
  const stremioHouseholdNetworkLimit = stremio ? int(body.stremioHouseholdNetworkLimit ?? '1', 1, 10, 'Stremio household connections') : 1;
  const stremioHouseholdLeaseMinutes = stremio ? int(body.stremioHouseholdLeaseMinutes ?? '240', 15, 1440, 'Stremio household lease') : 240;
  const stremioIpReplacementPolicy = stremio && STREMIO_REPLACEMENT_POLICIES.includes(body.stremioIpReplacementPolicy) ? body.stremioIpReplacementPolicy : 'customer_cooldown';
  const stremioIpReplacementCooldownMinutes = stremio && stremioIpReplacementPolicy === 'customer_cooldown' ? int(body.stremioIpReplacementCooldownMinutes ?? '1440', 15, 1440, 'Stremio household replacement cooldown') : 1440;
  const libraryMode = ['all', 'include', 'exclude'].includes(body.libraryAccessMode) ? body.libraryAccessMode : 'all';
  const libraries = libraryNames(body.libraryNames);
  if (jellyfin && libraryMode !== 'all' && !libraries.length) throw new Error('Enter at least one library name when using Include only or Exclude selected libraries.');
  const plan = {
    code, name, description, planKind, serviceType, audience, billing, duration, priceMinor, currency, capacityLimit, streams, isAddon,
    jellyfinAccessModel, jellyfinHouseholdNetworkLimit, jellyfinHouseholdLeaseMinutes,
    stremioHouseholdNetworkLimit, stremioHouseholdLeaseMinutes, stremioIpReplacementPolicy, stremioIpReplacementCooldownMinutes,
    serverClass: freeJellyfin ? 'free' : (jellyfin && ['premium', 'free', 'custom'].includes(body.serverClass) ? body.serverClass : 'premium'),
    visible: b(body.visible), active: b(body.active), downloads: jellyfin && b(body.allowDownloads), video: jellyfin && b(body.allowVideoTranscoding),
    audio: jellyfin && b(body.allowAudioTranscoding), remux: jellyfin && b(body.allowRemuxing), live: jellyfin && b(body.allowLiveTv),
    liveManagement: jellyfin && b(body.allowLiveTvManagement), remote: jellyfin && b(body.allowRemoteAccess), fourk: jellyfin && b(body.allow4k),
    subtitles: jellyfin && b(body.allowSubtitleEditing),
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
      `INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,is_addon,server_class,visible,active,sort_order,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,stremio_household_network_limit,stremio_household_lease_minutes,stremio_ip_replacement_policy,stremio_ip_replacement_cooldown_minutes,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,allow_subtitle_editing,library_access_mode,library_names,inactivity_policy)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::text[],$35::jsonb) RETURNING *`,
      [plan.code, plan.name, plan.description, plan.serviceType, plan.audience, plan.billing, plan.duration, plan.priceMinor, plan.currency, plan.capacityLimit, plan.isAddon, plan.serverClass, plan.visible, plan.active, nextOrder, plan.jellyfinAccessModel, plan.jellyfinHouseholdNetworkLimit, plan.jellyfinHouseholdLeaseMinutes, plan.stremioHouseholdNetworkLimit, plan.stremioHouseholdLeaseMinutes, plan.stremioIpReplacementPolicy, plan.stremioIpReplacementCooldownMinutes, plan.streams, plan.downloads, plan.video, plan.audio, plan.remux, plan.live, plan.liveManagement, plan.remote, plan.fourk, plan.subtitles, plan.libraryMode, plan.libraries, JSON.stringify(plan.inactivityPolicy)]
    );
    await planPricing.setPrice(client, result.rows[0].id, { currency: plan.currency, priceMinor: plan.priceMinor, active: true, isDefault: true });
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.create','plan',$2,$3::jsonb)`,
      [actorUserId, result.rows[0].id, JSON.stringify({ code: plan.code, planKind: plan.planKind, serviceType: plan.serviceType, audience: 'direct', currency: plan.currency, priceMinor: plan.priceMinor, capacityLimit: plan.capacityLimit, jellyfinAccessModel: plan.jellyfinAccessModel, streams: plan.streams, jellyfinHouseholdNetworkLimit: plan.jellyfinHouseholdNetworkLimit, jellyfinHouseholdLeaseMinutes: plan.jellyfinHouseholdLeaseMinutes, stremioHouseholdNetworkLimit: plan.stremioHouseholdNetworkLimit, stremioHouseholdLeaseMinutes: plan.stremioHouseholdLeaseMinutes, stremioIpReplacementPolicy: plan.stremioIpReplacementPolicy, stremioIpReplacementCooldownMinutes: plan.stremioIpReplacementCooldownMinutes, jellyfinPolicy: { downloads: plan.downloads, videoTranscoding: plan.video, audioTranscoding: plan.audio, remuxing: plan.remux, liveTv: plan.live, liveTvManagement: plan.liveManagement, remoteAccess: plan.remote, allow4k: plan.fourk, subtitleEditing: plan.subtitles, libraryAccessMode: plan.libraryMode, libraryNames: plan.libraries }, inactivityPolicy: plan.inactivityPolicy })]
    );
    return result.rows[0];
  });
}

function values(req, input = {}, currency = 'GBP') {
  const submitted = Boolean(input.__submitted);
  const requestedType = String(req.query?.type || '').toLowerCase();
  const requestedKind = requestedType === 'stremio' ? 'stremio' : requestedType === 'free' || requestedType === 'free_jellyfin' ? 'free_jellyfin' : 'paid_jellyfin';
  const planKind = submitted ? kindFromLegacy(input) : (PLAN_KINDS.includes(input.planKind) ? input.planKind : requestedKind);
  const service = serviceForKind(planKind);
  const billing = planKind === 'free_jellyfin' ? 'month' : (Object.prototype.hasOwnProperty.call(BILLING, input.billingInterval) ? input.billingInterval : 'month');
  const portalCurrency = CURRENCIES.includes(text(currency, 3).toUpperCase()) ? text(currency, 3).toUpperCase() : 'GBP';
  return {
    ...input,
    planKind,
    serviceType: service,
    billingInterval: billing,
    currency: portalCurrency,
    price: planKind === 'free_jellyfin' ? '0.00' : (input.price ?? '0.00'),
    durationDays: planKind === 'free_jellyfin' ? 30 : (input.durationDays ?? BILLING[billing].days ?? 30),
    capacityLimit: input.capacityLimit ?? '0',
    jellyfinAccessModel: JELLYFIN_ACCESS_MODELS.includes(input.jellyfinAccessModel) ? input.jellyfinAccessModel : 'concurrent_streams',
    streams: input.streams ?? '1',
    jellyfinHouseholdNetworkLimit: input.jellyfinHouseholdNetworkLimit ?? '1',
    jellyfinHouseholdLeaseMinutes: input.jellyfinHouseholdLeaseMinutes ?? '240',
    stremioHouseholdNetworkLimit: input.stremioHouseholdNetworkLimit ?? '1',
    stremioHouseholdLeaseMinutes: input.stremioHouseholdLeaseMinutes ?? '240',
    stremioIpReplacementPolicy: STREMIO_REPLACEMENT_POLICIES.includes(input.stremioIpReplacementPolicy) ? input.stremioIpReplacementPolicy : 'customer_cooldown',
    stremioIpReplacementCooldownMinutes: input.stremioIpReplacementCooldownMinutes ?? '1440',
    serverClass: planKind === 'free_jellyfin' ? 'free' : (input.serverClass || 'premium'),
    libraryAccessMode: input.libraryAccessMode || 'all',
    playbackWindowDays: input.playbackWindowDays ?? 7,
    minimumObservationHours: input.minimumObservationHours ?? 24,
    visible: submitted ? b(input.visible) : true,
    active: submitted ? b(input.active) : true,
    allowAudioTranscoding: submitted ? b(input.allowAudioTranscoding) : true,
    allowRemoteAccess: submitted ? b(input.allowRemoteAccess) : true,
    allow4k: submitted ? b(input.allow4k) : true,
    allowSubtitleEditing: submitted ? b(input.allowSubtitleEditing) : true,
    inactivityDryRun: submitted ? b(input.inactivityDryRun) : true
  };
}

function form(req, input = {}, error = '', currency = 'GBP') {
  const v = values(req, input, currency);
  const jellyfin = v.serviceType === 'jellyfin';
  const stremio = v.serviceType === 'stremio';
  const freeJellyfin = v.planKind === 'free_jellyfin';
  const paidJellyfin = v.planKind === 'paid_jellyfin';
  const householdJellyfin = jellyfin && v.jellyfinAccessModel === 'household_network';
  const replacementCooldown = stremio && v.stremioIpReplacementPolicy === 'customer_cooldown';
  const kindOptions = [
    ['free_jellyfin', 'Free Jellyfin', 'Free server access without billing controls.'],
    ['paid_jellyfin', 'Paid Jellyfin', 'Paid server access with pricing, billing and Jellyfin policy.'],
    ['stremio', 'Stremio', 'Unlimited streams/devices with a household connection allowance.']
  ];
  const kindPicker = kindOptions.map(([key, label, help]) => `<label class="planKindChoice ${v.planKind === key ? 'selected' : ''}"><input type="radio" name="planKind" value="${key}" ${checked(v.planKind === key)} data-plan-kind><span><strong>${esc(label)}</strong><small>${esc(help)}</small></span></label>`).join('');
  const body = `${notice(req)}${error ? `<div class="notice error">${esc(error)}</div>` : ''}
  <form class="adaptivePlanForm" method="post" action="/admin/plans" data-plan-create-v2>
    <input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="__submitted" value="1"><input type="hidden" name="serviceType" value="${esc(v.serviceType)}" data-plan-service>
    <section class="section planKindPanel"><div class="sectionHead"><div><span class="uiEyebrow">1 · Choose the product</span><h2>What are you selling?</h2><div class="muted">The rest of this page adapts to the product. Irrelevant commercial or delivery settings stay out of the way.</div></div></div><div class="planKindGrid">${kindPicker}</div></section>
    <div class="adaptivePlanGrid">
      <section class="section adaptivePlanCard adaptivePlanSpan"><div class="sectionHead"><div><span class="uiEyebrow">Identity</span><h3>Plan details</h3></div><span class="pill accent" data-plan-kind-label>${freeJellyfin ? 'FREE JELLYFIN' : paidJellyfin ? 'PAID JELLYFIN' : 'STREMIO'}</span></div><div class="formGrid adaptiveIdentityGrid"><div class="formGroup"><label>Code</label><input class="input" name="code" required pattern="[a-z0-9][a-z0-9-]{1,49}" maxlength="50" placeholder="monthly-access" value="${esc(v.code || '')}"><div class="inlineHelp">Lowercase letters, numbers and hyphens.</div></div><div class="formGroup"><label>Name</label><input class="input" name="name" required maxlength="80" placeholder="Monthly Access" value="${esc(v.name || '')}"></div></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500" rows="3" placeholder="What the customer gets with this plan">${esc(v.description || '')}</textarea></div></section>

      <section class="section adaptivePlanCard" data-commercial-card ${freeJellyfin ? 'hidden' : ''}><div class="sectionHead"><div><span class="uiEyebrow">Commercial</span><h3>Pricing & term</h3></div><span class="pill">${esc(v.currency)}</span></div><div class="formGrid adaptiveTwo"><div class="formGroup"><label>Price</label><div class="inputUnit"><input class="input" type="number" step="0.01" min="0" max="100000" name="price" value="${esc(v.price)}" data-plan-price><span>${esc(v.currency)}</span></div><div class="inlineHelp">Currency is portal-wide and not configurable per plan. Change it in Settings.</div></div><div class="formGroup"><label>Billing / access frequency</label><select class="input" name="billingInterval" data-plan-frequency>${Object.entries(BILLING).map(([x, d]) => `<option value="${x}" data-days="${d.days ?? ''}" ${selected(x, v.billingInterval)}>${esc(d.label)}</option>`).join('')}</select></div><div class="formGroup" data-plan-duration-group><label>Duration</label><div class="inputUnit"><input class="input" type="number" name="durationDays" min="1" max="3650" value="${esc(v.durationDays)}" data-plan-duration><span>days</span></div></div><div class="formGroup" data-paid-jellyfin-only ${paidJellyfin ? '' : 'hidden'}><label>Server class</label><select class="input" name="serverClass"><option value="premium" ${selected('premium', v.serverClass)}>Premium</option><option value="free" ${selected('free', v.serverClass)}>Free</option><option value="custom" ${selected('custom', v.serverClass)}>Custom</option></select><div class="inlineHelp">Use Custom only when explicit placement rules are required.</div></div></div></section>

      <section class="section adaptivePlanCard" data-availability-card><div class="sectionHead"><div><span class="uiEyebrow">Availability</span><h3>Sales state</h3></div></div><div class="formGroup"><label>Available slots</label><input class="input" type="number" min="0" max="1000000" name="capacityLimit" required value="${esc(v.capacityLimit)}"><div class="inlineHelp">Start at 0 while configuring the plan. Increase when it is ready to accept customers.</div></div><div class="toggleGrid compactToggles">${toggle('visible', 'Visible on storefront', v.visible)}${toggle('active', 'Active', v.active)}</div><div class="operatorCallout statusInfo compactCallout"><strong>Storefront order</strong><span> New plans are appended automatically. Reorder them later from Plans → Storefront order.</span></div></section>

      <section class="section adaptivePlanCard" data-jellyfin-access ${jellyfin ? '' : 'hidden'}><div class="sectionHead"><div><span class="uiEyebrow">Jellyfin</span><h3>Access model</h3></div></div><div class="formGroup"><label>Playback enforcement</label><select class="input" name="jellyfinAccessModel" data-jellyfin-access-model><option value="concurrent_streams" ${selected('concurrent_streams', v.jellyfinAccessModel)}>Concurrent streams</option><option value="household_network" ${selected('household_network', v.jellyfinAccessModel)}>Household connections</option></select><div class="inlineHelp">Choose the limit customers understand; internal network identity handling remains automatic.</div></div><div class="formGroup" data-jellyfin-stream-fields ${householdJellyfin ? 'hidden' : ''}><label>Concurrent streams</label><input class="input" type="number" name="streams" min="1" max="50" value="${esc(v.streams)}"></div><div data-jellyfin-household-fields ${householdJellyfin ? '' : 'hidden'}><div class="formGroup"><label>Household connections</label><input class="input" type="number" name="jellyfinHouseholdNetworkLimit" min="1" max="10" value="${esc(v.jellyfinHouseholdNetworkLimit)}"><div class="inlineHelp">How many different household internet connections may be active for this subscription.</div></div><details class="advancedCard"><summary>Advanced lease timing</summary><div class="formGroup"><label>Household lease</label><div class="inputUnit"><input class="input" type="number" name="jellyfinHouseholdLeaseMinutes" min="15" max="1440" value="${esc(v.jellyfinHouseholdLeaseMinutes)}"><span>minutes</span></div></div></details></div></section>

      <section class="section adaptivePlanCard" data-stremio-access ${stremio ? '' : 'hidden'}><div class="sectionHead"><div><span class="uiEyebrow">Stremio</span><h3>Household access</h3></div><span class="pill good">Unlimited streams</span></div><div class="accessFacts adaptiveAccessFacts"><div><span>Streams</span><strong>Unlimited</strong></div><div><span>Devices</span><strong>Unlimited</strong></div></div><div class="inlineHelp">Unlimited streams and unlimited devices; only household connections are limited.</div><div class="formGroup"><label>Household connections</label><input class="input" type="number" name="stremioHouseholdNetworkLimit" min="1" max="10" value="${esc(v.stremioHouseholdNetworkLimit)}"><div class="inlineHelp">Maximum number of different household internet connections that may use this Stremio subscription.</div></div><details class="advancedCard"><summary>Advanced household replacement</summary><div class="formGroup"><label>Connection replacement</label><select class="input" name="stremioIpReplacementPolicy" data-stremio-replacement><option value="customer_cooldown" ${selected('customer_cooldown', v.stremioIpReplacementPolicy)}>Customer can replace after cooldown</option><option value="auto_inactive" ${selected('auto_inactive', v.stremioIpReplacementPolicy)}>Automatically replace an inactive connection</option></select></div><div data-stremio-replacement-cooldown ${replacementCooldown ? '' : 'hidden'}><div class="formGroup"><label>Replacement cooldown</label><div class="inputUnit"><input class="input" type="number" name="stremioIpReplacementCooldownMinutes" min="15" max="1440" value="${esc(v.stremioIpReplacementCooldownMinutes)}"><span>minutes</span></div></div></div><div class="formGroup"><label>Connection lease</label><div class="inputUnit"><input class="input" type="number" name="stremioHouseholdLeaseMinutes" min="15" max="1440" value="${esc(v.stremioHouseholdLeaseMinutes)}"><span>minutes</span></div></div></details></section>

      <section class="section adaptivePlanCard adaptivePlanSpan" data-jellyfin-policy ${jellyfin ? '' : 'hidden'}><div class="sectionHead"><div><span class="uiEyebrow">Jellyfin</span><h3>User policy</h3></div><div class="muted">Only permissions that map to the Jellyfin user policy.</div></div><div class="toggleGrid compactPolicyGrid">${toggle('allowDownloads', 'Downloads', b(v.allowDownloads))}${toggle('allowVideoTranscoding', 'Video transcoding', b(v.allowVideoTranscoding))}${toggle('allowAudioTranscoding', 'Audio transcoding', b(v.allowAudioTranscoding))}${toggle('allowRemuxing', 'Remuxing', b(v.allowRemuxing))}${toggle('allowLiveTv', 'Live TV', b(v.allowLiveTv))}${toggle('allowLiveTvManagement', 'Live TV recording / management', b(v.allowLiveTvManagement))}${toggle('allowRemoteAccess', 'Remote access', b(v.allowRemoteAccess))}${toggle('allow4k', '4K catalogue flag', b(v.allow4k), 'Library access remains the actual visibility control.')}${toggle('allowSubtitleEditing', 'Edit subtitles', b(v.allowSubtitleEditing))}</div></section>

      <section class="section adaptivePlanCard" data-jellyfin-libraries ${jellyfin ? '' : 'hidden'}><div class="sectionHead"><div><span class="uiEyebrow">Jellyfin</span><h3>Libraries</h3></div></div><div class="formGroup"><label>Library access</label><select class="input" name="libraryAccessMode"><option value="all" ${selected('all', v.libraryAccessMode)}>All libraries</option><option value="include" ${selected('include', v.libraryAccessMode)}>Only named libraries</option><option value="exclude" ${selected('exclude', v.libraryAccessMode)}>All except named libraries</option></select></div><div class="formGroup"><label>Library names</label><textarea class="input" name="libraryNames" rows="4" placeholder="Movies\nTV\n4K Movies">${esc(v.libraryNames || '')}</textarea><div class="inlineHelp">One per line or comma-separated. Live-discovered libraries can be refined after creation.</div></div></section>

      <section class="section adaptivePlanCard" data-free-lifecycle ${freeJellyfin ? '' : 'hidden'}><div class="sectionHead"><div><span class="uiEyebrow">Free Jellyfin</span><h3>Usage rule <span class="muted">optional</span></h3></div></div><div class="operatorCallout compactCallout"><strong>Portal accounts are preserved.</strong><span> Matching this rule disables Jellyfin access only.</span></div><div class="formGrid adaptiveTwo"><div class="formGroup"><label>No playback for</label><div class="inputUnit"><input class="input" type="number" name="noPlaybackDays" min="1" max="3650" value="${esc(v.noPlaybackDays || '')}" placeholder="7"><span>days</span></div></div><div class="formGroup"><label>Minimum playback</label><div class="inputUnit"><input class="input" type="number" name="minimumPlaybackMinutes" min="1" max="1000000" value="${esc(v.minimumPlaybackMinutes || '')}" placeholder="30"><span>minutes</span></div></div><div class="formGroup"><label>Playback window</label><div class="inputUnit"><input class="input" type="number" name="playbackWindowDays" min="1" max="365" value="${esc(v.playbackWindowDays)}"><span>days</span></div></div><div class="formGroup"><label>Minimum observation</label><div class="inputUnit"><input class="input" type="number" name="minimumObservationHours" min="1" max="2160" value="${esc(v.minimumObservationHours)}"><span>hours</span></div></div></div><div class="toggleGrid compactToggles">${toggle('inactivityEnabled', 'Enable usage rule', b(v.inactivityEnabled))}${toggle('inactivityDryRun', 'Dry run only', b(v.inactivityDryRun), 'Recommended until the evidence preview looks right.')}</div></section>
    </div>
    <div class="adaptivePlanSaveBar"><div><strong data-plan-save-summary>${freeJellyfin ? 'Free Jellyfin plan' : paidJellyfin ? 'Paid Jellyfin plan' : 'Stremio plan'}</strong><span class="muted"> · availability starts closed when slots are 0</span></div><div class="buttonRow"><a class="button secondary" href="/admin/plans">Cancel</a><button class="button" type="submit">Create plan</button></div></div>
  </form><script src="/js/admin-plan-create-v2.js" defer></script>`;
  return body;
}

function createAdminPlanCreateV2Router() {
  const router = express.Router();
  router.use('/admin/plans', gate, noStore);
  router.get('/admin/plans/new', async (req, res, next) => {
    try {
      await runtimeSettings.ensureLoaded();
      const currency = (await reportingCurrency.get()).currency;
      return res.send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: 'New customer plan', subtitle: 'Choose the product first; CAPTAiNFiN only asks for settings that apply', body: form(req, {}, '', currency), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
    } catch (error) { next(error); }
  });
  router.post('/admin/plans', planCreateWriteLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    let currency = 'GBP';
    try {
      currency = (await reportingCurrency.get()).currency;
      const input = parse(req.body, currency);
      const created = await create(input, req.session.authUserId);
      const nextPath = input.serviceType === 'jellyfin' ? `/admin/plans/${created.id}/edit` : `/admin/plans/${created.id}/delivery`;
      const createdKind = input.planKind === 'free_jellyfin' ? 'Free Jellyfin' : input.planKind === 'paid_jellyfin' ? 'Paid Jellyfin' : 'Stremio';
      return res.redirect(`${nextPath}?message=${encodeURIComponent(`${createdKind} plan created. Availability remains closed until you open plan slots.`)}`);
    } catch (error) {
      if (error?.code === '23505') error = new Error('That plan code already exists.');
      try {
        return res.status(400).send(layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: 'New customer plan', subtitle: 'Choose the product first; CAPTAiNFiN only asks for settings that apply', body: form(req, req.body, error.message, currency), action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>' }));
      } catch (renderError) { return next(renderError); }
    }
  });
  return router;
}

module.exports = { createAdminPlanCreateV2Router, parse, create, form, values, kindFromLegacy, serviceForKind };
