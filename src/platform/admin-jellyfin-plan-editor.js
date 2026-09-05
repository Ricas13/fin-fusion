'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const runtimeSettings = require('./runtime-settings');
const capacity = require('../entitlements/plan-capacity');
const accessEditor = require('./admin-plan-access');
const libraryEditor = require('./admin-plan-libraries');
const planPricing = require('../payments/plan-pricing');
const paymentOptions = require('./admin-plan-payment-options');
const requestPlanPolicy = require('./admin-request-plan-policy');
const placement = require('../jellyfin/placement');
const discordRoles = require('../integrations/discord-roles');
const { queuePlanReconciliation, queuePlanDiscordReconciliation } = require('./bulk-jobs');
const { esc, layout } = require('./admin-html');
const planPolicy = require('../entitlements/plan-lifecycle-policy');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const checkboxForm = require('./admin-checkbox-form');

const writeLimit = routeRateLimit.middleware({ scope: 'admin-jellyfin-plan-editor', max: 40, windowSeconds: 60, reason: 'admin_jellyfin_plan_editor' });
const BILLING = new Set(['trial', 'month', '6_months', 'year', 'custom']);
const SERVER_CLASSES = new Set(['premium', 'free', 'custom']);

function gate(req, res, next) {
  return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function bool(value) { return value === true || ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase()); }
function text(value, max) { return String(value || '').trim().slice(0, max); }
function int(value, min, max, label) {
  const raw = String(value ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < min || parsed > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}
function money(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a valid non-negative price with no more than two decimal places.');
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000) throw new Error('Price must be between 0 and 100,000.');
  return Math.round(parsed * 100);
}
function selected(a, b) { return String(a) === String(b) ? 'selected' : ''; }
function checked(value) { return value ? 'checked' : ''; }
function token(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function values(value) { return [...new Set((Array.isArray(value) ? value : [value]).map(v => String(v || '').trim()).filter(Boolean))]; }
function freePlan(plan) { return Boolean(plan?.is_free_tier) || (Number(plan?.price_minor || 0) === 0 && String(plan?.billing_interval || '') !== 'trial' && String(plan?.server_class || '') === 'free'); }
function jellyfinPlan(plan) { return String(plan?.service_type || 'jellyfin') === 'jellyfin'; }
function editorUrl(planId, anchor = '') { return `/admin/plans/${encodeURIComponent(planId)}/edit${anchor ? `#${anchor}` : ''}`; }
function redirectWith(res, planId, kind, message, anchor = '') {
  return res.redirect(`/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}${anchor ? `#${anchor}` : ''}`);
}
function notices(req) {
  return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function impactField(plan, affected, label = 'live customer entitlements') {
  if (!affected) return '';
  return `<div class="formGroup"><label>Confirm impact</label><input class="input" name="impactConfirmation" autocomplete="off" required placeholder="Type ${esc(plan.code)}"><div class="inlineHelp">This plan currently affects ${esc(affected)} ${esc(label)}. Type the plan code to save this card.</div></div>`;
}
function requireImpact(plan, affected, value) {
  if (affected && String(value || '').trim() !== String(plan.code)) throw new Error(`Type ${plan.code} exactly to confirm the impact on ${affected} live customer entitlement${affected === 1 ? '' : 's'}.`);
}
function toggle(name, label, value, help = '') {
  return `<label class="toggleRow"><input type="checkbox" name="${esc(name)}" ${checked(value)}><span><strong>${esc(label)}</strong>${help ? `<small>${esc(help)}</small>` : ''}</span></label>`;
}

async function loadPlan(id) {
  const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
  return result.rows[0] || null;
}
async function serverChoices(plan) {
  const result = await query(`
    SELECT js.id,js.name,js.server_class,js.enabled,js.allow_new_users,js.health_status,
           pse.weight AS placement_weight,(pse.server_id IS NOT NULL) AS selected
    FROM jellyfin_servers js
    LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$1 AND pse.server_id=js.id
    ORDER BY js.server_class,js.priority,js.name`, [plan.id]);
  return result.rows;
}
async function loadData(plan) {
  const free = freePlan(plan);
  const [affected, usage, payment, servers, libraries, lifecycleGlobal, discordCatalogue] = await Promise.all([
    accessEditor.subscriberCount(plan.id),
    capacity.usage(plan.id),
    free ? Promise.resolve(null) : paymentOptions.mappings(plan.id),
    serverChoices(plan),
    libraryEditor.discoverLibraries(plan).catch(error => ({ servers: [], catalog: [], failed: [], error: error.message })),
    lifecyclePolicy.get(),
    discordRoles.roleCatalogue()
  ]);
  return { plan, free, affected, usage, payment, servers, libraries, access: accessEditor.values(plan), lifecycleGlobal, discordCatalogue };
}

function discordRoleReason(reason) {
  return ({
    bot_not_configured: 'Configure and enable the Discord bot first.',
    guild_not_configured: 'Add the Discord server (guild) ID in Notification settings.',
    discord_unavailable: 'CAPTAiNFiN could not read roles from Discord right now.',
    missing_manage_roles: 'The Discord bot is connected, but it does not have Manage Roles.',
    bot_role_hierarchy: 'Move the CAPTAiNFiN bot role above the customer roles you want it to manage.',
    no_assignable_roles: 'No assignable server roles are currently below the CAPTAiNFiN bot role.'
  })[reason] || 'Discord role assignment is not ready.';
}
function discordRoleControl(plan, catalogue = {}) {
  const current = discordRoles.snowflake(plan.discord_role_id) || '';
  const allRoles = Array.isArray(catalogue.roles) ? catalogue.roles : [];
  const assignable = Array.isArray(catalogue.assignableRoles) ? catalogue.assignableRoles : [];
  const currentRole = allRoles.find(role => String(role.id) === current) || null;
  const currentAssignable = assignable.some(role => String(role.id) === current);
  if (catalogue.ready) {
    const preserved = current && !currentAssignable ? `<option value="${esc(current)}" selected>Current mapping — ${esc(currentRole?.name || current)} · unavailable</option>` : '';
    const options = assignable.map(role => `<option value="${esc(role.id)}" ${String(role.id) === current ? 'selected' : ''}>${esc(role.name)}</option>`).join('');
    const warning = current && !currentAssignable ? `<div class="notice warn"><strong>Current mapping needs attention.</strong> ${currentRole ? `${esc(currentRole.name)} cannot currently be assigned by the bot (${esc(currentRole.reason || 'role hierarchy')}).` : `Role ${esc(current)} was not returned by this Discord server.`} Saving another role replaces it; leaving it selected preserves the existing mapping.</div>` : '';
    return `<div class="formGroup"><label>Discord plan role</label><select class="input" name="discordRoleId"><option value="" ${current ? '' : 'selected'}>No automatic Discord role</option>${preserved}${options}</select><div class="inlineHelp"><span class="pill good">Discord roles ready</span> ${assignable.length} assignable role${assignable.length === 1 ? '' : 's'} from the configured server. CAPTAiNFiN only adds/removes roles mapped to plans.</div>${warning}</div>`;
  }
  const detail = catalogue.error ? ` ${esc(catalogue.error)}` : '';
  return `<div class="formGroup"><label>Discord plan role</label><div class="notice warn"><strong>Role names unavailable.</strong> ${esc(discordRoleReason(catalogue.reason))}${detail}</div><label class="subText" for="discordRoleId">Manual role ID fallback</label><input id="discordRoleId" class="input" name="discordRoleId" maxlength="40" value="${esc(current)}" placeholder="Discord role snowflake ID"><div class="inlineHelp">The existing mapping is preserved while Discord is unavailable. You can also enter a valid role ID manually. <a href="/admin/notifications/preferences#messaging-settings">Open Discord settings</a>.</div></div>`;
}

function productCard(data, req) {
  const p = data.plan;
  const features = Array.isArray(p.marketing_features) ? p.marketing_features : [];
  const catalogue = data.free
    ? `<div class="planFreeStatement"><strong>Free product.</strong><span>No billing cycle or payment provider applies. It stays active and visible; set Availability to 0 whenever free acquisition should close.</span></div>`
    : `<div class="toggleGrid">${toggle('visible', 'Visible on storefront', p.visible)}${toggle('active', 'Available for acquisition', p.active)}</div>`;
  return `<section class="planConfigCard span2" id="product"><div class="planConfigHead"><div><h2>Product & storefront</h2><p>Customer-facing identity and catalogue state.</p></div><span class="pill ${data.free ? 'good' : 'accent'}">${data.free ? 'Free' : 'Paid Jellyfin'}</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-product">${token(req)}<div class="formGroup"><label>Name</label><input class="input" name="name" maxlength="80" required value="${esc(p.name)}"></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500" rows="3">${esc(p.description || '')}</textarea></div><div class="formGroup"><label>Homepage features</label><div class="formGrid">${[0, 1, 2, 3].map(i => `<input class="input" name="feature${i + 1}" aria-label="Homepage feature ${i + 1}" maxlength="90" value="${esc(features[i] || '')}" placeholder="Feature ${i + 1}">`).join('')}</div></div>${discordRoleControl(p, data.discordCatalogue)}${catalogue}${impactField(p, data.affected)}<div class="buttonRow"><button class="button" type="submit">Save product</button>${data.free ? '' : `<a class="button secondary" href="/admin/plans/order">Storefront order</a>`}</div></form></section>`;
}

function accessCard(data, req) {
  const p = data.plan, v = data.access, household = v.accessModel === 'household_network';
  return `<section class="planConfigCard" id="access"><div class="planConfigHead"><div><h2>Access specification</h2><p>Streams or household networks plus Jellyfin permissions.</p></div><span class="pill accent">Jellyfin</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-access">${token(req)}<div class="formGroup"><label>Playback enforcement</label><select class="input" name="jellyfinAccessModel" data-jellyfin-access-model><option value="concurrent_streams" ${selected(v.accessModel, 'concurrent_streams')}>Concurrent streams</option><option value="household_network" ${selected(v.accessModel, 'household_network')}>Household networks / IPs</option></select></div><div data-jellyfin-stream-fields ${household ? 'hidden' : ''}><div class="formGroup"><label>Concurrent streams</label><input class="input" type="number" min="1" max="50" name="streams" value="${esc(v.streams)}"></div></div><div data-jellyfin-household-fields ${household ? '' : 'hidden'}><div class="formGroup"><label>Simultaneous household networks</label><input class="input" type="number" min="1" max="10" name="jellyfinHouseholdNetworkLimit" value="${esc(v.jellyfinHouseholdNetworkLimit)}"></div><div class="formGroup"><label>Network lease</label><div class="inputUnit"><input class="input" type="number" min="15" max="1440" name="jellyfinHouseholdLeaseMinutes" value="${esc(v.jellyfinHouseholdLeaseMinutes)}"><span>minutes</span></div></div></div><details class="planCardDetails"><summary>Jellyfin permissions</summary><div class="planDetailsBody"><div class="planPermissionGrid">${toggle('allowDownloads', 'Downloads', v.allowDownloads)}${toggle('allowVideoTranscoding', 'Video transcoding', v.allowVideoTranscoding)}${toggle('allowAudioTranscoding', 'Audio transcoding', v.allowAudioTranscoding)}${toggle('allowRemuxing', 'Remuxing', v.allowRemuxing)}${toggle('allowLiveTv', 'Live TV', v.allowLiveTv)}${toggle('allowLiveTvManagement', 'Live TV management', v.allowLiveTvManagement)}${toggle('allowRemoteAccess', 'Remote access', v.allowRemoteAccess)}${toggle('allow4k', '4K catalogue flag', v.allow4k)}${toggle('allowSubtitleEditing', 'Edit subtitles', v.allowSubtitleEditing)}</div></div></details>${impactField(p, data.affected)}<div class="buttonRow"><button class="button" type="submit">Save access</button></div><div class="planSaveHint">Policy changes clear active household leases and queue Jellyfin reconciliation for affected customers.</div></form></section>`;
}

function availabilityCard(data, req) {
  const p = data.plan;
  const used = Number(data.usage.used || 0), reserved = Number(data.usage.reserved || 0);
  const limit = data.usage.limit == null ? null : Number(data.usage.limit);
  const remaining = data.usage.remaining == null ? null : Number(data.usage.remaining);
  const status = remaining == null ? 'No limit' : remaining > 0 ? `${remaining} open` : 'Closed';
  const tone = remaining == null || remaining > 0 ? 'good' : 'warn';
  return `<section class="planConfigCard" id="availability"><div class="planConfigHead"><div><h2>Availability</h2><p>How many new customers may acquire this plan.</p></div><span class="pill ${tone}">${esc(status)}</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-availability">${token(req)}<div class="planConfigFacts"><div class="planConfigFact"><span>Used</span><strong>${esc(used)}</strong></div><div class="planConfigFact"><span>Reserved</span><strong>${esc(reserved)}</strong></div><div class="planConfigFact"><span>Limit</span><strong>${limit == null ? '—' : esc(limit)}</strong></div><div class="planConfigFact"><span>Open</span><strong>${remaining == null ? '∞' : esc(remaining)}</strong></div></div><div class="formGroup"><label>Maximum plan slots</label><input class="input" type="number" min="0" max="1000000" name="capacityLimit" value="${esc(p.capacity_limit ?? 0)}" required><div class="inlineHelp">Set 0 to stop new acquisition. Existing customer access is preserved. In-progress Free registrations reserve a slot until completed or released.</div></div><button class="button" type="submit">Save availability</button></form></section>`;
}

function deliveryCard(data, req) {
  const p = data.plan;
  const strategy = placement.normalizeStrategy(p.placement_strategy);
  const restricted = data.servers.some(row => row.selected);
  const nextClass = data.free ? 'free' : p.server_class;
  const classControl = data.free
    ? `<div class="planFreeStatement"><strong>Free fleet.</strong><span>Free plans are pinned to the Free Jellyfin server class and do not inherit paid-plan placement.</span></div><input type="hidden" name="serverClass" value="free">`
    : `<div class="formGroup"><label>Server class</label><select class="input" name="serverClass"><option value="premium" ${selected(p.server_class, 'premium')}>Premium</option><option value="free" ${selected(p.server_class, 'free')}>Free</option><option value="custom" ${selected(p.server_class, 'custom')}>Custom</option></select></div>`;
  const serverRows = data.servers.map(row => {
    const unavailable = !row.enabled || !row.allow_new_users;
    return `<label class="planServerChoice"><input type="checkbox" name="serverIds" value="${esc(row.id)}" ${row.selected ? 'checked' : ''} ${unavailable ? 'disabled' : ''}><span><strong>${esc(row.name)}</strong><small>${esc(row.server_class)} · ${esc(row.health_status || 'checking')}${unavailable ? ' · unavailable for new users' : ''}</small></span><input class="input" type="number" min="1" max="10000" name="weight_${esc(row.id)}" value="${esc(row.placement_weight || 100)}" aria-label="${esc(row.name)} weight" ${unavailable ? 'disabled' : ''}></label>`;
  }).join('');
  return `<section class="planConfigCard span2" id="delivery"><div class="planConfigHead"><div><h2>Delivery & server placement</h2><p>Free and paid plans keep independent fleet targeting.</p></div><span class="pill accent">${esc(nextClass)} fleet</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-delivery">${token(req)}${classControl}<div class="formGrid"><div class="formGroup"><label>Placement strategy</label><select class="input" name="placementStrategy"><option value="balanced" ${selected(strategy, 'balanced')}>Balanced (recommended)</option><option value="lowest_customers" ${selected(strategy, 'lowest_customers')}>Lowest user count</option><option value="lowest_streams" ${selected(strategy, 'lowest_streams')}>Lowest live streams</option><option value="weighted" ${selected(strategy, 'weighted')}>Weighted distribution</option><option value="manual" ${selected(strategy, 'manual')}>Pinned server</option></select></div><div class="formGroup"><label>Eligible server pool</label><select class="input" name="poolMode"><option value="all" ${restricted ? '' : 'selected'}>All matching servers</option><option value="selected" ${restricted ? 'selected' : ''}>Only selected servers below</option></select></div></div><details class="planCardDetails"><summary>Select individual servers / weights</summary><div class="planDetailsBody"><div class="planServerChoices">${serverRows || '<div class="empty">No Jellyfin servers are configured.</div>'}</div></div></details>${impactField(p, data.affected)}<div class="buttonRow"><button class="button" type="submit">Save delivery</button></div></form></section>`;
}

function librariesCard(data, req) {
  const p = data.plan;
  const mode = ['all', 'include', 'exclude'].includes(p.library_access_mode) ? p.library_access_mode : 'all';
  const chosen = new Set((Array.isArray(p.library_names) ? p.library_names : []).map(v => String(v).toLocaleLowerCase('en-GB')));
  const discovery = data.libraries;
  const rows = (discovery.catalog || []).map(item => `<label class="libraryChoice"><input type="checkbox" name="libraryNames" value="${esc(item.name)}" ${chosen.has(String(item.name).toLocaleLowerCase('en-GB')) ? 'checked' : ''}><span><strong>${esc(item.name)}</strong><small>${esc(item.servers.length)} eligible server${item.servers.length === 1 ? '' : 's'}</small></span></label>`).join('');
  const warning = discovery.error ? `<div class="notice warn">Library discovery is temporarily unavailable: ${esc(discovery.error)}</div>` : (discovery.failed || []).length ? `<div class="notice warn">Could not read libraries from: ${esc(discovery.failed.join(', '))}</div>` : '';
  return `<section class="planConfigCard span2" id="libraries"><div class="planConfigHead"><div><h2>Library access</h2><p>What this plan can see after it is placed on an eligible server.</p></div><span class="pill">${esc(mode)}</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-libraries">${token(req)}${warning}<div class="formGroup"><label>Access mode</label><select class="input" name="libraryAccessMode"><option value="all" ${selected(mode, 'all')}>All libraries</option><option value="exclude" ${selected(mode, 'exclude')}>All except selected</option><option value="include" ${selected(mode, 'include')}>Only selected libraries</option></select></div><details class="planCardDetails" ${mode === 'all' ? '' : 'open'}><summary>Choose libraries</summary><div class="planDetailsBody"><div class="planLibraryChoices">${rows || '<div class="empty">No libraries were discovered from the current eligible server pool.</div>'}</div></div></details>${impactField(p, data.affected)}<div class="buttonRow"><button class="button" type="submit" ${discovery.error ? 'disabled' : ''}>Save libraries</button></div></form></section>`;
}

function lifecycleFormInput(body = {}) {
  return checkboxForm.explicitCheckboxes(body, '_lifecycleCheckboxes', ['enabled', 'dryRun']);
}
function lifecycleCard(data, req) {
  const p = data.plan, global = data.lifecycleGlobal, raw = p.inactivity_policy || {};
  const eff = planPolicy.effectiveForFreePlan(raw, global);
  const category = lifecyclePolicy.categoryFor({ billingInterval: p.billing_interval, priceMinor: p.price_minor });
  const inheritedDelete = lifecyclePolicy.deleteDays(global, category, { inactivity_policy: {} }).days;
  const triggers = [];
  if (eff.noPlaybackDays != null) triggers.push(`No playback for ${eff.noPlaybackDays} day${eff.noPlaybackDays === 1 ? '' : 's'}`);
  if (eff.minimumPlaybackMinutes != null) triggers.push(`Under ${eff.minimumPlaybackMinutes} minute${eff.minimumPlaybackMinutes === 1 ? '' : 's'} in ${eff.playbackWindowDays} day${eff.playbackWindowDays === 1 ? '' : 's'}`);
  const inheritsAll = Boolean(eff.inherited && eff.inherited.enabled && eff.inherited.dryRun && eff.inherited.noPlaybackDays);
  const triggerText = data.free
    ? (eff.enabled ? (triggers.length ? triggers.join(' · ') : 'Enabled, but no usage trigger is configured yet') : 'Usage rules disabled')
    : (category === 'trial' ? 'Trial entitlement expires' : 'Paid entitlement is no longer valid');
  const sourceText = inheritsAll ? 'Using global Free Server defaults' : 'Plan-specific lifecycle settings';
  const usageFields = data.free ? `<input type="hidden" name="_lifecycleCheckboxes" value="1"><div class="operatorCallout"><strong>Free Server Plan rules:</strong> current effective source: ${esc(sourceText)}. Saving this card creates a plan-specific override.</div><div class="planPermissionGrid">${toggle('enabled', 'Enable usage rules', eff.enabled, 'Uncheck to explicitly exempt this plan from the global Free Server inactivity rule.')}${toggle('dryRun', 'Dry run only', eff.dryRun, 'Global dry-run always wins; a plan cannot force enforcement while the global policy is dry-run.')}</div><div class="formGrid"><div class="formGroup"><label>No playback for</label><div class="inputUnit"><input class="input" type="number" name="noPlaybackDays" min="1" max="3650" value="${esc(eff.noPlaybackDays ?? '')}"><span>days</span></div><div class="inlineHelp">${eff.inherited?.noPlaybackDays ? `Currently inherited from the global Free Server default (${esc(global.freeNoPlaybackDays)} days).` : 'Blank = disable the no-playback trigger for this plan.'}</div></div><div class="formGroup"><label>Minimum playback</label><div class="inputUnit"><input class="input" type="number" name="minimumPlaybackMinutes" min="1" max="1000000" value="${esc(eff.minimumPlaybackMinutes ?? '')}" placeholder="30"><span>minutes</span></div></div><div class="formGroup"><label>Within</label><div class="inputUnit"><input class="input" type="number" name="playbackWindowDays" min="1" max="365" value="${esc(eff.playbackWindowDays)}"><span>days</span></div><div class="inlineHelp">Blank minimum = do not use the minimum-playback trigger.</div></div><div class="formGroup"><label>Minimum observation</label><div class="inputUnit"><input class="input" type="number" name="minimumObservationHours" min="1" max="2160" value="${esc(eff.minimumObservationHours)}"><span>hours</span></div><div class="inlineHelp">Prevents brand-new free users from being disabled before enough evidence exists.</div></div></div>` : '';
  return `<section class="planConfigCard span2" id="lifecycle"><div class="planConfigHead"><div><h2>Jellyfin lifecycle</h2><p>${data.free ? 'Free plans inherit the global inactivity rule until you save a plan-specific override.' : 'This plan is disabled when its entitlement lapses; you can override the post-disable deletion grace.'}</p></div>${data.free ? `<span class="pill ${inheritsAll ? 'good' : 'accent'}">${inheritsAll ? 'Inherited' : 'Override'}</span>` : ''}</div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-lifecycle">${token(req)}<div class="operatorCallout statusInfo"><strong>Portal identity is never automated away.</strong> These settings affect the Jellyfin user only. CAPTAiNFiN portal access remains until an administrator bans or deletes the portal account.</div>${usageFields}<div class="formGroup"><label>Delete Jellyfin user after being disabled</label><div class="inputUnit"><input class="input" type="number" name="deleteAfterDisableDays" min="1" max="3650" value="${esc(eff.deleteAfterDisableDays ?? '')}" placeholder="${esc(inheritedDelete)}"><span>days</span></div><div class="inlineHelp">Blank = inherit global ${esc(inheritedDelete)} days for ${esc(category)} access.</div></div><div class="buttonRow"><button class="button" type="submit">Save lifecycle</button><a class="button secondary" href="/admin/settings/jellyfin-lifecycle">Global defaults</a></div></form><div class="planConfigFacts"><div class="planConfigFact"><span>Disable trigger</span><strong>${esc(triggerText)}</strong></div>${data.free ? `<div class="planConfigFact"><span>Enforcement</span><strong>${eff.dryRun ? 'Dry run' : 'Enforce'}</strong></div>` : ''}<div class="planConfigFact"><span>Delete trigger</span><strong>${esc(eff.deleteAfterDisableDays ?? inheritedDelete)}d after disable</strong></div></div></section>`;
}

function verification(row) {
  if (!row) return '<span class="pill">Not configured</span>';
  const status = row.verification_status || 'unverified';
  const tone = status === 'verified' || status === 'not_required' ? 'good' : status === 'drift' || status === 'error' ? 'bad' : 'warn';
  return `<span class="pill ${tone}">${esc(status)}</span>`;
}
function paymentChoice(state, currency, provider, mode, label, requiresId) {
  const row = state.map.get(`${currency}:${provider}:${mode}`), key = `${currency}_${provider}_${mode}`;
  return `<div class="planPaymentOption"><div class="planPaymentOptionTop"><strong>${esc(label)}</strong>${verification(row)}</div><label class="toggleRow"><input type="checkbox" name="${esc(key)}_enabled" ${checked(Boolean(row?.active))}><span>Offer this option</span></label>${requiresId ? `<div class="formGroup"><label>${provider === 'stripe' ? 'Stripe Price ID' : 'PayPal Billing Plan ID'}</label><input class="input" name="${esc(key)}_external_id" value="${esc(row?.external_id || '')}" placeholder="${provider === 'stripe' ? 'price_...' : 'P-...'}"></div>` : '<div class="inlineHelp">One-time checkout uses the plan amount directly; no provider Price or Billing Plan ID is needed.</div>'}</div>`;
}
function commerceCard(data, req) {
  if (data.free) return '';
  const p = data.plan, state = data.payment, currency = state.currency;
  const priceRow = state.prices.find(row => row.currency === currency) || null;
  const amount = (Number(priceRow?.price_minor ?? p.price_minor ?? 0) / 100).toFixed(2);
  const mappings = priceRow ? `<form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-payments">${token(req)}<div class="planPaymentOptions">${paymentChoice(state, currency, 'stripe', 'payment', 'Stripe · one-time', false)}${paymentChoice(state, currency, 'stripe', 'subscription', 'Stripe · recurring', true)}${paymentChoice(state, currency, 'paypal', 'payment', 'PayPal · one-time', false)}${paymentChoice(state, currency, 'paypal', 'subscription', 'PayPal · recurring', true)}</div><div class="buttonRow"><button class="button" type="submit">Verify & save payment options</button></div></form>` : '<div class="planConfigBody"><div class="empty">Save the commercial schedule first, then configure payment options.</div></div>';
  return `<section class="planConfigCard span3" id="commerce"><div class="planConfigHead"><div><h2>Commercial schedule & payment options</h2><p>Paid plans only. Existing customer contract snapshots are never rewritten.</p></div><span class="pill accent">${esc(currency)}</span></div><form class="planConfigBody" method="post" action="/admin/plans/${esc(p.id)}/editor-commerce">${token(req)}<div class="formGrid"><div class="formGroup"><label>Price (${esc(currency)})</label><input class="input" type="number" step="0.01" min="0" max="100000" name="price" value="${esc(amount)}" required></div><div class="formGroup"><label>Billing interval</label><select class="input" name="billingInterval"><option value="trial" ${selected(p.billing_interval, 'trial')}>Trial</option><option value="month" ${selected(p.billing_interval, 'month')}>Monthly</option><option value="6_months" ${selected(p.billing_interval, '6_months')}>6 months</option><option value="year" ${selected(p.billing_interval, 'year')}>Yearly</option><option value="custom" ${selected(p.billing_interval, 'custom')}>Custom</option></select></div><div class="formGroup"><label>Access duration (days)</label><input class="input" type="number" min="1" max="3650" name="durationDays" value="${esc(p.duration_days || 30)}" required></div></div><button class="button" type="submit">Save commercial schedule</button></form><details class="planCardDetails"><summary>Payment provider options</summary><div class="planDetailsBody">${mappings}</div></details></section>`;
}

function page(data, req) {
  const p = data.plan;
  const open = data.usage.remaining == null ? null : Number(data.usage.remaining);
  const availabilityBadge = open == null ? 'No slot limit' : `${open} slots open`;
  const header = `<div class="planControlHeader"><div class="planControlIdentity"><strong>${esc(p.name)}</strong><span class="pill ${data.free ? 'good' : 'accent'}">${data.free ? 'Free Jellyfin' : 'Paid Jellyfin'}</span><span class="muted">${esc(data.affected)} live entitlement${data.affected === 1 ? '' : 's'}</span></div><div class="planControlIdentity"><span class="pill ${open == null || open > 0 ? 'good' : 'warn'}">${esc(availabilityBadge)}</span>${p.archived_at ? '<span class="pill warn">Archived</span>' : ''}</div></div>`;
  const body = `${notices(req)}<div class="planControlRoom">${header}<div class="planControlGrid">${productCard(data, req)}${accessCard(data, req)}${availabilityCard(data, req)}${deliveryCard(data, req)}${librariesCard(data, req)}${lifecycleCard(data, req)}${requestPlanPolicy.planCard(req, p)}${commerceCard(data, req)}</div>${data.free ? '<div class="securityNote standalone"><strong>Free plan independence:</strong> no price, payment mapping or billing interval is configured here. Free acquisition is controlled only by its own availability, access and delivery policy.</div>' : ''}</div><script src="/js/admin-plan-access.js" defer></script>`;
  return layout({ siteName: runtimeSettings.siteName(), active: 'plans', title: p.name, subtitle: data.free ? 'Free Access · independent product configuration' : 'Paid Jellyfin · unified product configuration', body, action: '<a class="button secondary" href="/admin/plans">Back to Plans</a>', pageClass: 'planReferencePage' });
}

async function saveProduct(req, plan, data) {
  requireImpact(plan, data.affected, req.body.impactConfirmation);
  const name = text(req.body.name, 80); if (!name) throw new Error('Enter a plan name.');
  const description = text(req.body.description, 500);
  const features = [1, 2, 3, 4].map(i => text(req.body[`feature${i}`], 90)).filter(Boolean).filter((v, i, all) => all.indexOf(v) === i);
  const visible = data.free ? true : bool(req.body.visible), active = data.free ? true : bool(req.body.active);
  const discordRoleIdRaw = text(req.body.discordRoleId, 40);
  const discordRoleId = discordRoleIdRaw ? discordRoles.snowflake(discordRoleIdRaw) : null;
  if (discordRoleIdRaw && !discordRoleId) throw new Error('Choose a Discord role or enter a valid Discord role ID.');
  const previousDiscordRoleId = discordRoles.snowflake(plan.discord_role_id);
  const discordRoleChanged = previousDiscordRoleId !== discordRoleId;
  if (!data.free && !active && plan.active) {
    const setting = await query(`SELECT setting_value FROM platform_settings WHERE setting_key='trial_free_policy'`);
    const value = setting.rows[0]?.setting_value || {};
    if (value.downgradeToFree === true && String(value.downgradeFreePlanCode || '') === String(plan.code)) throw new Error('This plan is the configured automatic free-downgrade target. Choose another target under Plans → Access rules before disabling it.');
  }
  await transaction(async client => {
    await client.query(`UPDATE plans SET name=$2,description=$3,marketing_features=$4::text[],visible=$5,active=$6,discord_role_id=$7,updated_at=NOW() WHERE id=$1`, [plan.id, name, description, features, visible, active, discordRoleId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.product.update','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ name, visible, active, freeTier: data.free, discordRoleId, previousDiscordRoleId, discordRoleChanged })]);
  });
  if (discordRoleChanged && data.affected) await queuePlanDiscordReconciliation(plan.id, req.session.authUserId, { discordExtraManagedRoleIds: previousDiscordRoleId ? [previousDiscordRoleId] : [] });
}
async function saveAccess(req, plan, data) {
  requireImpact(plan, data.affected, req.body.impactConfirmation);
  const input = accessEditor.parse(plan, req.body || {});
  await accessEditor.save(plan, input, req.session.authUserId);
  if (data.affected) await queuePlanReconciliation(plan.id, req.session.authUserId);
}
async function saveAvailability(req, plan) {
  const limit = int(req.body.capacityLimit, 0, 1000000, 'Availability limit');
  await transaction(async client => {
    await client.query('UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1', [plan.id, limit]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.inventory.update','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ capacityLimit: limit })]);
  });
}
async function saveDelivery(req, plan, data) {
  requireImpact(plan, data.affected, req.body.impactConfirmation);
  const serverClass = data.free ? 'free' : (SERVER_CLASSES.has(String(req.body.serverClass)) ? String(req.body.serverClass) : null);
  if (!serverClass) throw new Error('Choose Premium, Free or Custom as the server class.');
  const strategy = placement.normalizeStrategy(req.body.placementStrategy);
  const poolMode = req.body.poolMode === 'selected' ? 'selected' : 'all';
  const ids = values(req.body.serverIds);
  const available = await query(`SELECT id,name,enabled,allow_new_users FROM jellyfin_servers WHERE server_class=$1 ORDER BY priority,name`, [serverClass]);
  const byId = new Map(available.rows.map(row => [String(row.id), row]));
  const chosen = ids.map(id => byId.get(id)).filter(Boolean);
  if (poolMode === 'selected' && !chosen.length) throw new Error('Choose at least one eligible server or use all matching servers.');
  if (chosen.some(row => !row.enabled || !row.allow_new_users)) throw new Error('Disabled servers or servers closed to new users cannot be selected.');
  if (strategy === 'manual' && (poolMode !== 'selected' || chosen.length !== 1)) throw new Error('Pinned server placement requires exactly one selected server.');
  const configured = chosen.map(row => ({ id: row.id, weight: int(req.body[`weight_${row.id}`] || '100', 1, 10000, `${row.name} weight`) }));
  await transaction(async client => {
    await client.query('UPDATE plans SET server_class=$2,placement_strategy=$3,updated_at=NOW() WHERE id=$1', [plan.id, serverClass, strategy]);
    await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [plan.id]);
    if (poolMode === 'selected') for (const row of configured) await client.query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,$3)', [plan.id, row.id, row.weight]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.server_placement','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ serverClass, strategy, poolMode, servers: configured, freeTier: data.free })]);
  });
}
async function saveLibraries(req, plan, data) {
  requireImpact(plan, data.affected, req.body.impactConfirmation);
  const mode = ['all', 'include', 'exclude'].includes(req.body.libraryAccessMode) ? req.body.libraryAccessMode : 'all';
  const discovery = await libraryEditor.discoverLibraries(plan);
  if (discovery.failed.length) throw new Error(`Library access was not changed because these servers could not be read: ${discovery.failed.join(', ')}.`);
  const available = new Map(discovery.catalog.map(item => [String(item.name).toLocaleLowerCase('en-GB'), item.name]));
  const names = values(req.body.libraryNames).map(name => available.get(name.toLocaleLowerCase('en-GB'))).filter(Boolean);
  if (mode === 'include' && !names.length) throw new Error('Choose at least one library for selected-only access.');
  await transaction(async client => {
    await client.query('UPDATE plans SET library_access_mode=$2,library_names=$3::text[],updated_at=NOW() WHERE id=$1', [plan.id, mode, mode === 'all' ? [] : names]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.library_access','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ mode, names, liveEntitlements: data.affected })]);
  });
  if (data.affected) await queuePlanReconciliation(plan.id, req.session.authUserId);
}
async function saveCommerce(req, plan, data) {
  if (data.free) throw new Error('Free plans do not have a commercial schedule.');
  const billing = BILLING.has(String(req.body.billingInterval)) ? String(req.body.billingInterval) : null;
  if (!billing) throw new Error('Choose a billing interval.');
  const duration = int(req.body.durationDays, 1, 3650, 'Access duration');
  const priceMinor = money(req.body.price);
  const currency = await planPricing.platformDefaultCurrency();
  const before = await planPricing.resolvePrice(plan.id, currency, { allowFallback: false });
  const pricingChanged = !before || Number(before.price_minor) !== priceMinor;
  const intervalChanged = String(plan.billing_interval) !== billing;
  await transaction(async client => {
    await client.query('UPDATE plans SET billing_interval=$2,duration_days=$3,updated_at=NOW() WHERE id=$1', [plan.id, billing, duration]);
    const price = await planPricing.setPrice(client, plan.id, { currency, priceMinor, active: true, isDefault: true });
    if (pricingChanged || intervalChanged) await client.query(`UPDATE plan_provider_prices SET active=FALSE,verification_status='unverified',verification_error='Plan commercial schedule changed; re-verification required.',updated_at=NOW() WHERE plan_price_id=$1`, [price.id]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.commerce.update','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ currency, priceMinor, billingInterval: billing, durationDays: duration })]);
  });
}
async function saveLifecycle(req, plan) {
  await planPolicy.save(plan.id, lifecycleFormInput(req.body), req.session.authUserId);
}
async function savePayments(req, plan, data) {
  if (data.free) throw new Error('Free plans do not use payment mappings.');
  const currency = await planPricing.platformDefaultCurrency();
  const price = await planPricing.resolvePrice(plan.id, currency, { allowFallback: false });
  if (!price) throw new Error(`${currency} is not configured for this plan.`);
  const specs = [['stripe', 'payment'], ['stripe', 'subscription'], ['paypal', 'payment'], ['paypal', 'subscription']], validated = [];
  for (const [provider, mode] of specs) {
    const key = `${currency}_${provider}_${mode}`, enabled = bool(req.body[`${key}_enabled`]), externalId = text(req.body[`${key}_external_id`], 200);
    validated.push({ provider, mode, enabled, externalId, verification: await paymentOptions.verifyOption(plan, price, provider, mode, enabled, externalId) });
  }
  await transaction(async client => {
    for (const item of validated) await paymentOptions.saveOption(client, plan, price, item.provider, item.mode, item.enabled, item.externalId, item.verification);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.payment_options','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ currency, verified: true, unifiedEditor: true })]);
  });
}

async function currentData(req, res, next) {
  const plan = await loadPlan(req.params.id);
  if (!plan) { res.status(404).send('Plan not found'); return null; }
  if (!jellyfinPlan(plan)) return null;
  await runtimeSettings.ensureLoaded();
  return loadData(plan);
}
function post(handler, success, anchor) {
  return [writeLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const data = await currentData(req, res, next); if (!data) return next();
      await handler(req, data.plan, data);
      return redirectWith(res, data.plan.id, 'message', success, anchor);
    } catch (error) {
      return redirectWith(res, req.params.id, 'error', error.message || 'Plan settings could not be saved.', anchor);
    }
  }];
}
function decodePlanId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function createAdminJellyfinPlanEditorRouter() {
  const router = express.Router();
  router.use('/admin/plans', gate, noStore);
  router.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const pathname = req.path;
    let match = pathname.match(/^\/admin\/plans\/([^/]+)\/edit$/);
    if (match) {
      const planId = decodePlanId(match[1]);
      return Promise.resolve().then(async () => {
        const plan = await loadPlan(planId);
        if (!plan || !jellyfinPlan(plan)) return next();
        await runtimeSettings.ensureLoaded();
        return res.send(page(await loadData(plan), req));
      }).catch(next);
    }
    const legacy = [
      [/^\/admin\/plans\/([^/]+)\/(?:access|jellyfin)$/, 'access'],
      [/^\/admin\/plans\/([^/]+)\/inventory$/, 'availability'],
      [/^\/admin\/plans\/([^/]+)\/placement$/, 'delivery'],
      [/^\/admin\/plans\/([^/]+)\/libraries$/, 'libraries'],
      [/^\/admin\/plans\/([^/]+)\/lifecycle$/, 'lifecycle'],
      [/^\/admin\/plans\/([^/]+)\/commerce$/, 'commerce']
    ];
    for (const [pattern, anchor] of legacy) {
      match = pathname.match(pattern);
      if (!match) continue;
      const planId = decodePlanId(match[1]);
      return Promise.resolve(loadPlan(planId)).then(plan => {
        if (!plan || !jellyfinPlan(plan)) return next();
        return res.redirect(302, editorUrl(plan.id, anchor));
      }).catch(next);
    }
    return next();
  });
  router.post('/admin/plans/:id/editor-product', ...post(saveProduct, 'Product details saved.', 'product'));
  router.post('/admin/plans/:id/editor-access', ...post(saveAccess, 'Access policy saved.', 'access'));
  router.post('/admin/plans/:id/editor-availability', ...post(saveAvailability, 'Availability saved.', 'availability'));
  router.post('/admin/plans/:id/editor-delivery', ...post(saveDelivery, 'Delivery and placement saved.', 'delivery'));
  router.post('/admin/plans/:id/editor-libraries', ...post(saveLibraries, 'Library access saved.', 'libraries'));
  router.post('/admin/plans/:id/editor-lifecycle', ...post(saveLifecycle, 'Jellyfin lifecycle override saved.', 'lifecycle'));
  router.post('/admin/plans/:id/editor-commerce', ...post(saveCommerce, 'Commercial schedule saved. Re-verify payment options if it changed.', 'commerce'));
  router.post('/admin/plans/:id/editor-payments', ...post(savePayments, 'Payment options verified and saved.', 'commerce'));
  router.get('/admin/plans/:id/stremio', async (req, res) => {
    try {
      const plan = await loadPlan(req.params.id);
      if (!plan) return res.status(404).send('Plan not found');
      if (!['stremio', 'bundle'].includes(String(plan.service_type || ''))) return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?error=${encodeURIComponent('This plan does not include Stremio.')}`);
      return res.redirect(`/admin/servers/stremio?plan=${encodeURIComponent(plan.id)}&message=${encodeURIComponent(`${plan.name}: Stremio sources, libraries and runtime are managed in the Stremio control centre.`)}`);
    } catch (error) {
      return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message || 'Stremio settings could not be opened.')}`);
    }
  });
  return router;
}

module.exports = { createAdminJellyfinPlanEditorRouter, loadData, page, freePlan, jellyfinPlan, lifecycleFormInput, discordRoleControl };