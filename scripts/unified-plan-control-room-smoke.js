'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const routes = read('src/platform/admin-route-composition.js');
const editor = read('src/platform/admin-jellyfin-plan-editor.js');
const stremioEditor = read('src/platform/admin-stremio-plan-editor.js');
const stremioDispatch = read('src/platform/admin-stremio-plan-dispatch.js');
const attentionPolicy = read('src/platform/actionable-attention-policy.js');
const operatorState = read('src/platform/admin-operator-state.js');
const attentionSource = read('src/platform/attention.js');
const css = read('public/css/admin-plan-control-room.css');
const densityCss = read('public/css/admin-card-density.css');
const capability = read('public/css/admin-capability.css');
const groupingCss = read('public/css/admin-settings-groups.css');
const attention = read('src/platform/admin-attention.js');
const baseline = read('db/migrations/000_database_baseline.sql');
const settingsGroups = read('public/js/admin-settings-groups.js');
const navigationCoherence = read('public/js/admin-navigation-coherence.js');
const planAccessClient = read('public/js/admin-plan-access.js');
const mediaControls = read('src/platform/admin-media-controls.js');
const planAccessSource = read('src/platform/admin-plan-access.js');
const laneStreamSource = read('src/jellyfin/lane-stream-policy.js');
const registrySource = read('src/jellyfin/registry.js');
const fourKPolicySource = read('src/jellyfin/four-k-transcode-policy.js');
const identityPolicySource = read('src/jellyfin/media-identity-policy.js');
const devicePolicySource = read('src/jellyfin/device-access-policy.js');
const paygReminderSource = read('src/jellyfin/payg-expiry-messages.js');
const mediaPlanSettingsSource = read('src/jellyfin/media-plan-policy-settings.js');
const activityWorker = read('scripts/activity-worker.js');
const runtimeRoles = read('scripts/configure-runtime-db-roles.js');
const fourKMigration = read('db/migrations/20260831190000_plan_4k_transcode_policy.sql');
const deviceMigration = read('db/migrations/20260901000000_media_device_allowlist.sql');
const discordRoleUi = read('src/platform/admin-plan-discord-role.js');
const discordRoleSource = read('src/integrations/discord-roles.js');
const bulkWorkerSource = read('src/jellyfin/bulk-worker.js');
const bulkJobsSource = read('src/platform/bulk-jobs.js');

assert(routes.includes('createAdminJellyfinPlanEditorRouter'), 'route composition must mount the unified Jellyfin plan editor');
assert(routes.indexOf('createAdminJellyfinPlanEditorRouter()') < routes.indexOf('createAdminPlanAccessRouter()'), 'unified Jellyfin dispatch must run before legacy plan GET owners');
assert(editor.includes('const pathname = req.path') && editor.includes("pathname.match(/^\\/admin\\/plans\\/([^/]+)\\/edit$/)"), 'unified editor must dispatch the canonical Jellyfin edit page without registering a duplicate formal GET owner');
assert(!editor.includes("router.get('/admin/plans/:id/edit'"), 'unified editor must not duplicate the assembled /edit route owner');
for (const anchor of ['access', 'availability', 'delivery', 'libraries', 'commerce']) {
  assert(editor.includes(`'${anchor}'`), `unified editor must expose/redirect the ${anchor} configuration area`);
}
assert(editor.includes("String(plan?.service_type || 'jellyfin') === 'jellyfin'"), 'unified editor must target current Jellyfin products only, not retired historical bundle products');
assert(editor.includes("if (data.free) return '';"), 'free plans must omit the commercial/payment card entirely');
assert(editor.includes('No billing cycle or payment provider applies'), 'free plan UI must explain its independence from paid commerce');
assert(editor.includes('Free plan independence:'), 'free plan editor must explicitly keep commerce outside free-plan configuration');
assert(editor.includes('editor-product') && editor.includes('editor-access') && editor.includes('editor-availability') && editor.includes('editor-delivery') && editor.includes('editor-libraries'), 'single-page plan cards must have independent save handlers');
assert(editor.includes('editor-commerce') && editor.includes('editor-payments'), 'paid Jellyfin plans must configure schedule and payment options from the unified page');
assert(editor.includes('data-jellyfin-access-model'), 'Jellyfin access card must preserve the optional legacy household policy switch');
assert(editor.includes('Maximum plan slots'), 'availability must be configurable directly in the unified editor');
assert(editor.includes('Delivery & server placement'), 'server class and placement must be configured in the unified editor');
assert(editor.includes('Library access'), 'library access must be configured directly in the unified editor');
assert(baseline.includes("marketing_features text[] DEFAULT '{}'::text[] NOT NULL"), 'baseline must keep marketing features as a PostgreSQL text array');
assert(editor.includes('marketing_features=$4::text[]'), 'product editor must persist homepage features using the schema text-array type');
assert(!editor.includes('marketing_features=$4::jsonb'), 'product editor must never cast marketing features to jsonb');
assert(editor.includes('[plan.id, name, description, features, visible, active'), 'product editor must bind the feature array directly instead of JSON-encoding it');

// Discord plan roles are ordinary per-plan settings, while reconciliation stays a bounded specialist job.
assert(editor.includes('Discord plan role') && editor.includes('discord_role_id=$7'), 'Jellyfin product settings must expose and persist the plan Discord role');
assert(stremioEditor.includes('discordRoleUi.control') && stremioEditor.includes('discord_role_id=$7'), 'Stremio product settings must expose and persist the same plan Discord role contract');
assert(discordRoleUi.includes('function control(') && discordRoleUi.includes('function parse(') && discordRoleUi.includes('CAPTAiNFiN only adds/removes roles mapped to plans'), 'shared Discord plan-role UI must keep safe parsing and explain its managed-role boundary');
assert(discordRoleSource.includes('extraManagedRoleIds') && discordRoleSource.includes('managed.add(roleId)'), 'Discord reconciliation must be able to remove a replaced old managed role without treating unrelated Discord roles as managed');
assert(bulkJobsSource.includes('queuePlanDiscordReconciliation') && bulkJobsSource.includes("'discord_plan_reconcile'"), 'plan-role changes must queue a dedicated bounded Discord reconciliation job');
assert(bulkWorkerSource.includes("registerHandler('discord_plan_reconcile'") && bulkWorkerSource.includes('reconcileDiscordRoles'), 'bulk worker must own the dedicated Discord-only reconciliation handler');
assert(!bulkWorkerSource.slice(bulkWorkerSource.indexOf("registerHandler('discord_plan_reconcile'"), bulkWorkerSource.indexOf("registerHandler('plan_source_rebuild'")).includes('effective_customer_entitlements'), 'Discord-only fanout must not regress to a broad entitlement-view mutation path');

assert(stremioEditor.includes('Plan, storefront & commerce') && stremioEditor.includes('name="description"') && stremioEditor.includes('name="feature${i + 1}"'), 'Stremio must edit storefront copy inside its existing product/commerce card');
assert(stremioEditor.includes('UPDATE plans SET name=$2,description=$3,marketing_features=$4::text[],billing_interval=$5,duration_days=$6'), 'the Stremio product/commerce save must persist storefront copy in the same mutation');
assert(stremioEditor.includes("post('editor-storefront', saveStorefront, 'Storefront saved.')"), 'legacy Storefront POST must remain accepted by the compatibility Stremio editor router');
assert(stremioEditor.includes('UPDATE plans SET description=$2,marketing_features=$3::text[],updated_at=NOW() WHERE id=$1'), 'Storefront compatibility save must write the same description/features columns without changing commerce ownership');
assert(!stremioEditor.includes('Save storefront'), 'Stremio must not render a second Storefront Save button or editor');
assert(stremioEditor.includes('if (!sources.length) return') && stremioEditor.includes('Manage sources'), 'empty Stremio Sources must point to source management instead of presenting a useless Save');
assert(stremioEditor.includes("res.redirect(`/admin/plans?error=${encodeURIComponent(error.message || 'Plan not found')}`)"), 'missing Stremio plans must return to the catalogue with an error notice instead of rendering Not found as page/header content');
assert(routes.includes('createAdminStremioPlanDispatchRouter'), 'route composition must mount the live Stremio plan dispatcher');
assert(routes.indexOf('createAdminStremioPlanDispatchRouter()') < routes.indexOf('createAdminJellyfinPlanEditorRouter()'), 'Stremio card saves must be dispatched before shared Jellyfin plan routes can match them');
assert(stremioDispatch.includes('(editor-commerce|editor-storefront|editor-access|editor-availability|editor-payments)'), 'the mounted Stremio dispatcher must own every card POST rendered by the Stremio edit page');
for (const [action, handler] of [['editor-commerce','saveCommerce'],['editor-storefront','saveStorefront'],['editor-access','saveAccess'],['editor-availability','saveAvailability'],['editor-payments','savePayments']]) {
  assert(stremioDispatch.includes(`['${action}',{handler:editor.${handler}`), `mounted Stremio dispatcher must route ${action} to editor.${handler}`);
}
assert(stremioDispatch.includes("if(!data||String(data.plan.service_type)!=='stremio')return next();"), 'Stremio card dispatch must fall through for non-Stremio plans so Jellyfin routing remains intact');
assert(stremioDispatch.includes("cardRedirect(res,data.plan.id,'error'"), 'Stremio card save failures must return to the same editor with a useful error instead of falling through to Not found');

assert(attentionPolicy.includes("const REQUIRED_ENABLED_JOBS = new Set(['payment_events', 'plan_changes'])"), 'payment-event retry and plan-change lifecycle jobs must be declared operator-required');
assert(attentionPolicy.includes("health === 'disabled' && REQUIRED_ENABLED_JOBS.has(jobKey)") && attentionPolicy.includes("reason: 'disabled'"), 'disabled required payment lifecycle jobs must become operator-visible alerts immediately');
assert(attentionSource.includes('jobHealth.list()'), 'Needs Attention must derive job alerts from the canonical automation job snapshot');
assert(operatorState.includes('attention.openSummary()'), 'header Alerts count must use the same Needs Attention snapshot as the Alerts page');

assert(capability.includes("@import url('/css/admin-plan-control-room.css')"), 'shared admin shell must load the plan/attention layout corrections');
assert(css.includes('.planControlGrid{display:grid;grid-template-columns:1fr!important'), 'plan editor must keep a safe one-column base before responsive enhancements');
assert(css.includes('@media(min-width:820px)') && css.includes('.planControlGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important'), 'plan editor must use two compact columns at normal admin widths');
assert(css.includes('@media(min-width:1280px)') && css.includes('.planControlGrid{grid-template-columns:repeat(3,minmax(0,1fr))!important'), 'plan editor must use the requested three-column desktop body rhythm');
assert(css.includes('.planConfigCard.span2,.planConfigCard.span3{grid-column:auto!important}'), 'legacy span classes must no longer force full-width rows in the compact editor');
assert(css.includes('.planControlGrid>.requestPlanCard{grid-column:auto!important'), 'request/Jellyseerr policy must participate in the compact grid instead of remaining a full-width monster card');
assert(css.includes('.requestQuotaGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important}'), 'request quotas must stay readable inside a compact card instead of squeezing four fields into one row');
assert(css.includes('overflow-wrap:normal;word-break:normal;hyphens:none'), 'toggle titles must not wrap in the middle of words');
assert(!densityCss.includes('.planControlGrid{') && !densityCss.includes('.planControlGrid>'), 'card-density CSS must not override planControlGrid geometry or spans');
assert(css.includes('.planControlHeader{display:none!important}'), 'duplicate plan status strip must stay out of the editor');
assert(css.includes('@media(max-width:700px)') && css.includes('.planControlGrid{grid-template-columns:1fr!important}'), 'plan editor must stay one column on small screens');
assert(css.includes('.planControlRoom,.planControlGrid{gap:12px}') && css.includes('.planConfigBody{padding:12px 13px}'), 'narrow plan editors must retain readable card spacing instead of desktop-density padding');
assert(css.includes('@media(max-width:480px)') && css.includes('.planServerChoice{grid-template-columns:auto minmax(0,1fr)}'), 'very narrow server controls must stack the weight input rather than squeeze three columns');
assert(css.includes('.section.bulkBar{overflow:visible}'), 'bulk-action sections must not clip controls or focus rings at the shared section boundary');
assert(css.includes('.attentionBulkBar .input.compact,.attentionActionGrid .input.compact{min-width:0!important'), 'attention workflow inputs must be allowed to shrink instead of forcing horizontal overflow');
assert(css.includes('.attentionActionGrid{grid-template-columns:minmax(92px'), 'attention row workflow must use bounded responsive columns');
assert(attention.includes('responsiveTable attentionTable'), 'Needs Attention table must opt into the constrained workflow layout');

// Per-card Basic / Advanced and page-level troubleshooting Logs.
assert(capability.includes("@import url('/css/admin-settings-groups.css')"), 'shared admin capability stylesheet must load the settings-group styles');
assert(navigationCoherence.includes("script.src='/js/admin-settings-groups.js'"), 'all admin shells must load the settings grouping enhancer through the shared navigation script');
assert(settingsGroups.includes("function markBasic(card"), 'settings grouping must mark Basic Settings inside each owning card');
assert(settingsGroups.includes("'adminSettingsCardGrade', 'Basic Settings'"), 'each grouped card must visibly identify its always-visible Basic Settings');
assert(settingsGroups.includes("promoteExistingAdvanced(card") && settingsGroups.includes("'Advanced Settings'"), 'existing specialist controls must become per-card Advanced Settings disclosures');
assert(settingsGroups.includes("'access-advanced-settings'"), 'the Access card must own its Advanced Settings disclosure');
assert(!settingsGroups.includes("advancedNodes = ['delivery', 'lifecycle', 'requests']"), 'whole plan cards must never be moved into a page-level Advanced Settings bucket');
assert(settingsGroups.includes("disclosure('logs', 'Logs'") && settingsGroups.includes('adminSettingsPageLogs'), 'each supported page must end with one collapsed troubleshooting Logs disclosure');
assert(groupingCss.includes('.adminSettingsPageLogs') && groupingCss.includes('font-size:10px'), 'troubleshooting logs must stay deliberately compact and low-emphasis');
const disclosureStart = settingsGroups.indexOf('function disclosure(');
const disclosureEnd = settingsGroups.indexOf('function bodyOf(', disclosureStart);
const disclosureSource = settingsGroups.slice(disclosureStart, disclosureEnd);
assert(disclosureStart >= 0 && disclosureEnd > disclosureStart, 'settings disclosure helper must exist');
assert(!/\.open\s*=|setAttribute\(\s*['"]open['"]/.test(disclosureSource), 'Advanced Settings and Logs disclosures must be collapsed by default');
assert(settingsGroups.includes('if (!details.open || loaded) return;'), 'log history must load lazily only after the collapsed Logs disclosure is opened');
assert(settingsGroups.includes('revealHashTarget'), 'a deliberate post-save anchor may reopen the relevant collapsed card disclosure');
assert(settingsGroups.includes('label.htmlFor = input.id'), 'dynamically generated advanced controls must keep explicit accessible labels');

// Jellyfin/Emby media controls.
assert(routes.includes("const { createAdminMediaControlsRouter } = require('./admin-media-controls')"), 'route composition must import the media controls owner');
assert(routes.includes('app.use(createAdminMediaControlsRouter());'), 'media controls must be mounted in the production admin router');
assert(fourKMigration.includes('kick_4k_transcodes boolean NOT NULL DEFAULT FALSE'), '4K transcode kick must be opt-in and default off');
assert(activityWorker.includes("require('../src/jellyfin/four-k-transcode-policy')") && activityWorker.includes('runFourKTranscodeCycle()'), 'the activity worker must execute the 4K transcode policy cycle');
assert(activityWorker.includes("require('../src/jellyfin/media-identity-policy')") && activityWorker.includes('runMediaIdentityPolicyCycle({ failedServerIds })'), 'the activity worker must execute independent IP and registered-device policy reconciliation');
assert(activityWorker.includes("require('../src/jellyfin/payg-expiry-messages')") && activityWorker.includes('runPaygExpiryMessageCycle({ failedServerIds })'), 'the activity worker must execute in-stream Pay As You Go reminders');
assert(mediaControls.includes('/connection-policy') && mediaControls.includes('ipLimit') && mediaControls.includes('deviceLimit'), 'plan media controls must expose independent IP and persistent device caps');
assert(mediaControls.includes('/4k-transcode') && mediaControls.includes("admin.plan.4k_transcode_policy"), 'plan media controls must persist and audit 4K transcode policy changes');
assert(mediaControls.includes('/message') && mediaControls.includes('/Message') && mediaControls.includes('activeManagedSessions'), 'server media controls must send messages only to active managed media-server sessions');
assert(mediaControls.includes('providerLabel') && mediaControls.includes("mediaProvider.label"), 'manual in-client messaging must work through the Jellyfin/Emby provider adapter');
assert(mediaControls.includes('attempted: results.length, sent, failed'), 'media-server message delivery must be audited with attempted/sent/failed counts');
assert(settingsGroups.includes('Playback connection limits') && settingsGroups.includes('Active IP addresses') && settingsGroups.includes('Authorised devices'), 'Access Advanced Settings must expose IP and persistent registered-device limits');
assert(settingsGroups.includes('Concurrent streams') && settingsGroups.includes('independent of the IP and registered-device limits'), 'Access Basic Settings must explain that concurrent streams remain an independent limit');
assert(settingsGroups.includes('Pay As You Go expiry messages') && settingsGroups.includes('after 30 seconds of active playback'), 'Access Advanced Settings must explain the in-stream PAYG reminder schedule');
assert(settingsGroups.includes('4K Video Transcoding Kick') && settingsGroups.includes('Jellyfin/Emby warning'), 'Access Advanced Settings must expose 4K transcode enforcement for both providers');
assert(fourKPolicySource.includes("const POLICY_REASON = 'plan_4k_transcode_kick'"), '4K policy events must use a stable log reason');
assert(mediaPlanSettingsSource.includes("KEY_PREFIX = 'media_plan_policy_v1:'") && mediaPlanSettingsSource.includes('paygExpiryMessagesEnabled: true'), 'per-plan media connection settings must default safely without a schema-wide behavior change');
assert(identityPolicySource.includes("await registry.request(row.serverId, `/Sessions/${encodeURIComponent(row.sessionId)}/Message`") && identityPolicySource.indexOf('/Message') < identityPolicySource.indexOf('/Playing/Stop'), 'excess IP playback must receive an in-client warning before the stop request');
assert(identityPolicySource.includes('media_identity_revalidation_failed') && identityPolicySource.includes('media_identity_violation_cleared_before_action'), 'IP kicks must revalidate live state and fail closed on uncertainty');
assert(!identityPolicySource.includes("identityOverflow(rows, 'deviceIdentity'"), 'device limits must not regress to simultaneous-device counting');
assert(deviceMigration.includes('CREATE TABLE IF NOT EXISTS media_account_devices') && deviceMigration.includes('revoked_at') && deviceMigration.includes('media_account_device_policy'), 'persistent device slots and reset history must be migration-owned');
assert(devicePolicySource.includes('EnableAllDevices: ids.length === 0') && devicePolicySource.includes('EnabledDevices: ids'), 'device policy must use the media server native per-user allowlist');
assert(devicePolicySource.includes('registerObserved') && devicePolicySource.includes('deviceLimit - registered.length'), 'first observed Device IDs must claim persistent slots up to the plan limit');
assert(devicePolicySource.includes('resetAccountDevices') && mediaControls.includes('/devices/:accountId') && mediaControls.includes("admin.media_device_access.reset"), 'admins must be able to reset registered devices from a mounted audited route');
assert(settingsGroups.includes('Registered media devices') && settingsGroups.includes('Reset registered devices'), 'Customer Access must expose registered devices and the reset action');
assert(registrySource.includes('managedDevicePolicyBody') && registrySource.includes('EnableAllDevices:false') && registrySource.includes('EnabledDevices:ids'), 'later Jellyfin/Emby policy reconciliation must preserve an enforced device allowlist');
assert(!laneStreamSource.includes("if (entitlement.jellyfin_access_model === 'household_network') return null;"), 'concurrent stream enforcement must stay active even when the optional legacy household lease is enabled');
assert(planAccessSource.includes("streams: jellyfin ? int(body.streams, 0, 50, 'Concurrent streams')"), 'saving household/network settings must preserve the independent concurrent-stream cap, including 0 = unlimited');
assert(planAccessClient.includes('stream.forEach(el=>{el.hidden=false;})'), 'legacy Access UI must keep the independent concurrent-stream field visible');
assert(paygReminderSource.includes('const REMINDER_DAYS = new Set([7, 1, 0])') && paygReminderSource.includes('const STREAM_AGE_SECONDS = 30'), 'PAYG reminders must run at 7 days, 1 day and expiry day only after 30 seconds of playback');
assert(paygReminderSource.includes("s.source IN ('stripe','paypal','plisio')") && paygReminderSource.includes("s.billing_mode='payment'") && !paygReminderSource.includes("provider_subscription_id,'') ~* '^sub_'") && !paygReminderSource.includes("provider_subscription_id,'') ~* '^I-'"), 'PAYG reminders must use billing_mode for one-time eligibility and never infer billing truth from provider ID prefixes');
assert(paygReminderSource.includes("detail->>'deliveryDate'=$3") && paygReminderSource.includes("reason=$1 AND detail->>'subscriptionId'=$2"), 'successful PAYG messages must be deduplicated per subscription and local day');
assert(runtimeRoles.includes('media_account_device_policy') && runtimeRoles.includes('media_account_devices') && runtimeRoles.includes('status,source,billing_mode,provider_subscription_id,current_period_end'), 'least-privilege activity role must be able to reconcile device slots and read canonical subscription billing identity');

const fourKPolicy = require('../src/jellyfin/four-k-transcode-policy');
const directPlay4k = { Id: 's1', NowPlayingItem: { Id: 'i1', Width: 3840, Height: 2160 }, PlayState: { PlayMethod: 'DirectPlay' } };
const transcode4kSource = { Id: 's2', NowPlayingItem: { Id: 'i2', Width: 3840, Height: 2160 }, PlayState: { PlayMethod: 'Transcode' }, TranscodingInfo: { Width: 1920, Height: 1080 } };
const transcode1080 = { Id: 's3', NowPlayingItem: { Id: 'i3', Width: 1920, Height: 1080 }, PlayState: { PlayMethod: 'Transcode' }, TranscodingInfo: { Width: 1280, Height: 720 } };
const transcode4kOutput = { Id: 's4', NowPlayingItem: { Id: 'i4', Width: 1920, Height: 1080 }, PlayState: { PlayMethod: 'Transcode' }, TranscodingInfo: { Width: 3840, Height: 2160 } };
assert.strictEqual(fourKPolicy.isFourKVideoTranscode(directPlay4k), false, '4K Direct Play must never be kicked');
assert.strictEqual(fourKPolicy.isFourKVideoTranscode(transcode4kSource), true, 'a 4K source being down-transcoded must be detected');
assert.strictEqual(fourKPolicy.isFourKVideoTranscode(transcode1080), false, 'ordinary 1080p transcoding must not be kicked');
assert.strictEqual(fourKPolicy.isFourKVideoTranscode(transcode4kOutput), true, '4K transcode output must be detected');

const identityPolicy = require('../src/jellyfin/media-identity-policy');
assert.strictEqual(identityPolicy.canonicalRemoteIp('192.168.1.4:8096'), '192.168.1.4', 'IPv4 session endpoints must be canonicalized without their port');
assert.strictEqual(identityPolicy.canonicalRemoteIp('[2001:db8::4]:8096'), '2001:db8::4', 'bracketed IPv6 session endpoints must be canonicalized without their port');
assert.strictEqual(identityPolicy.canonicalRemoteIp('not-an-address'), null, 'uncertain remote identity must never be treated as a kickable IP');
const overflow = identityPolicy.identityOverflow([
  { sessionId: 'old', ipIdentity: '10.0.0.1', firstSeenAt: new Date('2026-08-31T10:00:00Z'), isPaused: false },
  { sessionId: 'middle', ipIdentity: '10.0.0.2', firstSeenAt: new Date('2026-08-31T10:01:00Z'), isPaused: false },
  { sessionId: 'new', ipIdentity: '10.0.0.3', firstSeenAt: new Date('2026-08-31T10:02:00Z'), isPaused: false }
], 'ipIdentity', 2, { countPaused: false });
assert.deepStrictEqual(overflow.overflow.map(row => row.sessionId), ['new'], 'oldest active IP identities must be preserved and the newest excess identity kicked');

const devicePolicy = require('../src/jellyfin/device-access-policy');
const observedDevices = devicePolicy.observedDevices([
  { Id: 's2', UserId: 'USER', DeviceId: 'device-b', DeviceName: 'Phone', Client: 'Emby Mobile', LastActivityDate: '2026-09-01T10:02:00Z' },
  { Id: 's1', UserId: 'user', DeviceId: 'device-a', DeviceName: 'Shield', Client: 'Emby Android TV', LastActivityDate: '2026-09-01T10:01:00Z' },
  { Id: 's3', UserId: 'other', DeviceId: 'device-c', LastActivityDate: '2026-09-01T10:00:00Z' }
], 'user');
assert.deepStrictEqual(observedDevices.map(row => row.deviceId), ['device-a','device-b'], 'device-slot claiming must use stable Device IDs for the intended media user in first-seen order');

const payg = require('../src/jellyfin/payg-expiry-messages');
assert.strictEqual(payg.reminderDay(new Date('2026-09-07T11:00:00Z'), new Date('2026-08-31T11:00:00Z'), 'Europe/London'), 7, 'PAYG calendar-day calculation must identify the 7-day reminder');
assert.strictEqual(payg.reminderDay(new Date('2026-09-01T11:00:00Z'), new Date('2026-08-31T11:00:00Z'), 'Europe/London'), 1, 'PAYG calendar-day calculation must identify the 1-day reminder');
assert.strictEqual(payg.reminderDay(new Date('2026-08-31T22:00:00Z'), new Date('2026-08-31T11:00:00Z'), 'Europe/London'), 0, 'PAYG calendar-day calculation must identify expiry day');

console.log('unified plan control room smoke: ok');