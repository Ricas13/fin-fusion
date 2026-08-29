'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const ui = read('src/platform/admin-ui.js');
const css = read('public/css/admin-operator-clarity.css');
const capability = read('public/css/admin-capability.css');
const dashboard = read('src/platform/admin-dashboard.js');
const attention = read('src/platform/admin-attention.js');
const attentionSource = read('src/platform/attention.js');
const backups = read('src/platform/admin-backups.js');
const servers = read('src/platform/admin-servers-dashboard.js');
const customers = read('src/platform/admin-users-dashboard.js');
const automation = read('src/platform/admin-automation.js');
const notifications = read('src/platform/admin-notification-preferences.js');
const payments = read('src/platform/admin-payment-settings.js');
const commerce = read('src/platform/admin-commerce.js');
const plans = read('src/platform/admin-plans-list.js');
const stableCustomerNav = read('public/js/customer-360-navigation.js');
const orders = read('src/platform/admin-orders.js');
const billing = read('src/platform/admin-billing.js');
const support = read('src/platform/admin-support-tickets.js');
const events = read('src/platform/admin-events.js');
const integrations = read('src/platform/admin-integrations-overview.js');
const playback = read('src/platform/admin-activity.js');
const playbackEvents = read('src/jellyfin/activity-policy-events.js');
const playbackView = read('views/admin/activity.ejs');
const provisioning = read('src/platform/admin-provisioning.js');
const drift = read('src/platform/admin-drift.js');
const migrations = read('src/platform/admin-server-migrations.js');
const fleetOperations = read('src/platform/admin-fleet-operations.js');
const serverControl = read('src/platform/admin-server-fleet-dashboard.js');
const provisioningTabs = read('src/platform/provisioning-workflow-tabs.js');
const nav = read('src/platform/admin-nav.js');
const routes = read('src/platform/admin-route-composition.js');

for (const primitive of ['operatorHero', 'resolutionCard', 'detailDisclosure']) {
  assert(ui.includes(`function ${primitive}`), `shared admin UI must expose ${primitive}`);
  assert(ui.includes(primitive), `shared admin UI exports must include ${primitive}`);
}
assert(ui.includes('PAGE_STATUS_HERO_ENABLED = false') && ui.includes('operatorHeroActions-compact'), 'page-level status heroes must stay retired while preserving their operator actions compactly');
for (const tone of ['operatorHero-good', 'operatorHero-warn', 'operatorHero-bad', 'operatorHero-commerce', 'operatorHero-streaming']) {
  assert(css.includes(tone), `operator clarity CSS must retain dormant hero styling for backwards compatibility`);
}
assert(css.includes('.operatorHeroActions-compact{margin:0 0 12px}'), 'retired status heroes must leave only a compact action row when actions are needed');
assert(capability.includes("@import url('/css/admin-operator-clarity.css')"), 'operator clarity CSS must load through canonical admin capability bundle');

assert(dashboard.includes('function dashboardHero(ctx)') && dashboard.includes('Profit this month') && dashboard.includes('Profit YTD'), 'Home must retain an explicit profit-first business hero');
assert(dashboard.includes('used / sellable stream capacity') && dashboard.includes('Needs attention'), 'Home hero must pair live stream capacity with the canonical intervention count');
assert(dashboard.indexOf('dashboardHero(ctx)') < dashboard.indexOf('rangeControls(ctx.range)'), 'Home hero must remain before analytics controls in composition');
assert(!dashboard.includes('function attentionOverview') && !dashboard.includes('setupCompact'), 'Home must not reintroduce a second attention list or setup tile outside the focused hero');
assert(attention.includes('Current problem & next step') && attention.includes('actionLabel'), 'Needs Attention must present the current problem and the concrete recovery action separately from workflow controls');
assert(attention.includes('Automatic retries and recovery history remain elsewhere.'), 'Needs Attention must keep self-healing and historical failures out of the intervention queue');
assert(attentionSource.includes('/admin/servers/dashboard?server='), 'single-server attention items must preserve server context when opening the fleet control room');

assert(backups.includes('selectedResolution') && backups.includes('You came here to fix this'), 'Backups must render contextual resolution when opened from an issue');
assert(backups.includes('Verify this backup now'), 'Backups must provide an explicit verification action for the selected recovery point');
assert(backups.includes('name="runId"'), 'backup verification requests must preserve the selected recovery-point identity');
assert(backups.includes("WHERE id=$1 AND status='succeeded' AND file_path IS NOT NULL"), 'selected verification must only accept an existing successful encrypted recovery point');
assert(backups.includes('Recent recovery points') && backups.includes('Full backup history'), 'backup history must be recent-first with full history behind deliberate disclosure');
assert(backups.includes('There is intentionally no browser “Restore” button'), 'destructive recovery must remain host-side');
assert(!backups.includes("require('child_process')") && !backups.includes('exec(') && !backups.includes('spawn('), 'operator clarity must not add browser shell execution');

assert(servers.includes('Jellyfin fleet control room'), 'Servers dashboard must retain canonical fleet-health calculation');
assert(servers.includes('selectedServerResolution') && servers.includes('You came here to fix this'), 'Servers dashboard must preserve and explain issue context');
assert(servers.includes('Open ${esc(server.name)} settings'), 'unhealthy server context must expose the corrective settings action');
assert(servers.includes('fleetSummary'), 'fleet state must summarize health, streams, users and capacity from canonical fleet rows');

assert(customers.includes('Customer control room') && customers.includes('customerHero(ctx)'), 'Customers dashboard must retain canonical customer-health calculation');
assert(customers.indexOf('customerHero(ctx)') < customers.indexOf("rangeControls(ctx.range,'/admin/users/dashboard')"), 'Customer health calculation must remain before analytics controls in composition');
assert(customers.includes('ctx.data.needsAttention'), 'Customer health must reuse canonical Needs Attention data instead of creating a second exception model');

assert(automation.includes('Automation control room') && automation.includes('automationHero(jobs,worker,workerAlive)'), 'Automation must retain worker/job health calculation');
assert(automation.includes('Fix these jobs first') && automation.includes('All automation schedules'), 'Automation must expose failures before progressively disclosed routine schedules');
assert(automation.includes("jobHealth.healthState(job)"), 'Automation clarity must reuse canonical job-health state');

assert(notifications.includes('Notification control room') && notifications.includes('Fix failed deliveries first'), 'Notifications must retain delivery failure health calculation before configuration');
assert(notifications.includes("ui.detailDisclosure({title:'Messaging apps & credentials'") && notifications.includes('Global event catalogue'), 'Notification credentials and routing catalogue must be progressively disclosed');
assert(!notifications.includes('<th>Destination</th>'), 'Default notification history must not expose recipient destinations');
assert(notifications.includes('notificationOutbox.recent(80)'), 'Notification health must reuse the canonical outbox history');

assert(payments.includes('Payment control room') && payments.includes('Failed provider events'), 'Payments must retain provider-safety calculation and expose failed events');
assert(payments.includes('payment-provider-config') && payments.includes('integrationConfig') && payments.includes('detailsHtml:providerConfigDetails(req,provider,status,url)') && !payments.includes("title:'Stripe, PayPal & Plisio credentials'"), 'Payment credentials must live behind deliberate inline provider disclosure without a duplicate combined configuration block');
assert(payments.includes("providerEvents=(events||[]).filter(event=>event.provider===provider)"), 'Payment cards must reuse canonical provider event state');
assert(payments.includes("latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)"), 'Payment provider evidence must remain based on successfully processed events');

assert(commerce.includes('Commerce control room') && commerce.includes('Payment incidents to resolve'), 'Commerce must retain customer-impacting payment state before revenue analytics');
assert(commerce.indexOf('commerceHero(d,dashboardCtx)') < commerce.indexOf("rangeControls(dashboardCtx.range,'/admin/commerce')"), 'Commerce state calculation must remain before analytics controls in composition');
assert(commerce.includes("d.paymentIncidents.filter(row=>!row.resolved_at)"), 'Commerce clarity must reuse canonical payment incidents');
assert(commerce.includes("ui.detailDisclosure({title:'Commercial policies & detailed payment state'"), 'Routine commercial policy/state detail must be progressively disclosed');

assert(!plans.includes('Product control room'), 'Plans must open directly on the small catalogue instead of rendering a page-level readiness hero');
assert(plans.includes('readiness.evaluate(plan, ctx)') && plans.includes('live_subscriber_count'), 'Plan rows must still derive sale readiness and capacity from canonical state');
assert(!plans.includes('Plan policies & storefront tools') && plans.includes('/admin/plans/access-rules') && plans.includes('/admin/plans/order'), 'Plans must expose Access rules and Storefront order directly without a separate policy disclosure');
assert(!plans.includes('data-plan-filters') && !plans.includes('data-plan-search'), 'Plans must not render filters for the deliberately small catalogue');
assert(plans.includes('archived=1') && plans.includes('Retired catalogue versions'), 'Archived plan versions must remain reachable without cluttering the active catalogue');

for (const tab of ["['overview','Overview'", "['access','Access'", "['billing','Billing'", "['activity','Activity'"]) {
  assert(stableCustomerNav.includes(tab), `Customer 360 primary workspace must retain ${tab}`);
}
assert(!stableCustomerNav.includes("['manage','Manage'") && !stableCustomerNav.includes("['security','Security'") && !stableCustomerNav.includes("['history','History'"), 'Customer 360 primary navigation must be exactly Overview, Access, Billing and Activity');
assert(stableCustomerNav.includes("link.setAttribute('href',href)") && stableCustomerNav.includes('MutationObserver'), 'late service-aware enrichment must not mutate Customer 360 navigation after render');

assert(orders.includes('Transaction desk') && orders.includes('Open customer billing →'), 'Orders must act as a transaction trail into customer billing rather than a raw record table');
assert(orders.includes("ui.detailDisclosure({title:`Full purchase history"), 'Older order history must be progressively disclosed');
assert(!orders.includes('provider_subscription_id'), 'Orders must not expose provider subscription identifiers in the normal transaction view');

assert(billing.includes('Billing operations') && billing.includes('Fix these subscriptions first'), 'Billing must expose customer-impacting recurring problems before routine reconciliation');
assert(billing.includes("row.status==='past_due'||Boolean(row.last_error)"), 'Billing problems must derive from canonical subscription/provider-sync state');
assert(billing.includes("ui.detailDisclosure({title:`All recurring subscriptions"), 'Routine recurring-subscription state must be progressively disclosed');
assert(!billing.includes('<th>Provider ID</th>'), 'Billing default tables must not make raw provider identifiers an operator-facing column');

assert(support.includes('Support desk') && support.includes('Reply these first'), 'Support must lead with customer conversations waiting on staff');
assert(support.includes("['open','awaiting_staff'].includes(row.status)"), 'Support priority must reuse canonical ticket lifecycle state');
assert(support.includes("ui.detailDisclosure({title:'Ticket routing & status'"), 'Support routing/status controls must stay secondary to the conversation and reply action');
assert(support.includes('Internal note (staff only)'), 'Support clarity must preserve the internal-note privacy boundary');

assert(events.includes('Audit & incident trail') && events.includes('Needs investigation'), 'Audit log must surface operational failures before routine history');
assert(events.includes("row.kind==='incident')return !d.resolvedAt"), 'Audit incident severity must use canonical resolved state');
assert(events.includes("ui.detailDisclosure({title:`Full audit history"), 'Routine audit history must be progressively disclosed');
assert(!events.includes("recipient_email,'attempts'"), 'Audit queries must not pull notification recipient addresses into the combined operator trail');
assert(!events.includes("row.subject_id?' · '"), 'Audit default rendering must not print raw subject/provider identifiers');

assert(integrations.includes('Integration control room') && integrations.includes('Fix enabled integrations first'), 'Connections must retain enabled-but-incomplete service state');
assert(integrations.includes('enabled&&!configured'), 'Integration issue state must distinguish incomplete enabled services from intentionally disabled ones');
assert(integrations.includes('providerSettings.status') && integrations.includes('emailSettings.status') && integrations.includes('notificationSettings.status'), 'Connections overview must reuse canonical status providers');
assert(nav.includes("['settings-integrations','Connections','/admin/settings/integrations']"), 'Settings navigation must open the Connections integration-health control room');
assert(routes.includes('createAdminIntegrationsOverviewRouter()') && routes.indexOf('createAdminIntegrationsOverviewRouter()') < routes.indexOf('createAdminOriginalSettingsRouter()'), 'Connections overview must mount before the legacy settings owner without replacing its canonical mutation routes');

assert(playback.includes('Playback control room') && playback.includes('playbackHero(data,policy,state)'), 'Playback must retain live operator-state calculation');
assert(playback.includes('customer_stream_count') && playback.includes('overLimitCustomers'), 'Playback exceptions must derive from the canonical live-session counts and stream limits');
assert(playback.includes("decision==='stop_failed'") && playback.includes('policyEvents.safetyAttention'), 'Playback must distinguish failed enforcement from safety-blocked actions');
for (const reason of ['incomplete_server_snapshot', 'revalidation_failed']) {
  assert(playbackEvents.includes(`'${reason}'`), `shared playback safety taxonomy must include ${reason}`);
}
assert(playbackEvents.includes('client_does_not_report_media_control_support') && playbackEvents.includes('legacy safety event'), 'historical unsupported-client safety events must remain readable in policy history');
const safetyBlock = playbackEvents.slice(playbackEvents.indexOf('SAFETY_ATTENTION_REASONS'), playbackEvents.indexOf('REASON_LABELS'));
assert(!safetyBlock.includes('client_does_not_report_media_control_support'), 'missing client media-control support must no longer block confirmed stream-limit enforcement');
for (const reason of ['jellyfin_stop_did_not_end_session', 'jellyfin_force_logout_failed', 'post_stop_revalidation_failed']) {
  assert(playbackEvents.includes(`${reason}:`), `shared playback policy taxonomy must explain ${reason}`);
}
assert(playback.includes("require('../jellyfin/activity-policy-events')"), 'Playback operator UI must reuse the shared Jellyfin policy-event taxonomy');
assert(playbackEvents.includes('function reasonLabel') && playbackEvents.includes('function decisionLabel'), 'shared playback taxonomy must own operator-facing event labels');
assert(playbackView.includes('Fix these playback issues first') && playbackView.includes('Recent policy decisions &amp; safety checks'), 'Playback must surface current exceptions and significant decisions before routine detail');
assert(playbackView.indexOf('<%- heroHtml %>') < playbackView.indexOf('Stream policy &amp; enforcement settings'), 'Playback state composition must remain before policy configuration');
assert(playbackView.includes('<details class="operatorDetails" id="playback-policy">'), 'Playback policy configuration must be progressively disclosed');
assert(playbackView.includes('Fleet context') && playbackView.includes('Full policy event history') && playbackView.includes('Routine playback history'), 'Fleet context and routine playback history must remain available behind deliberate disclosure');
assert(playbackView.includes('I_UNDERSTAND_THIS_STOPS_PLAYBACK'), 'Playback enforcement must preserve the explicit destructive-action acknowledgement');
assert(!playbackView.includes('remote_endpoint') && !playbackView.includes('jellyfin_session_id'), 'Playback UI must not expose raw network endpoints or Jellyfin session identifiers');

assert(provisioning.includes('Provisioning control room') && provisioning.includes('These customer access problems have outlasted automatic recovery'), 'Provisioning must retain failed/blocked customer-access state while excluding transient retry noise');
assert(provisioning.includes('Repair access now') && provisioning.includes("ui.detailDisclosure({title:'All customer access state'"), 'Provisioning must provide an explicit repair action and progressively disclose routine state');
assert(provisioning.includes("row.username||row.email||'CAPTAiNFiN customer'"), 'Provisioning must not fall back to rendering a raw customer UUID');
assert(provisioning.includes('Recheck all active customers') && !provisioning.includes('Queue all effective'), 'Provisioning maintenance controls must use task language rather than reconciliation jargon');

assert(drift.includes("title:'Access consistency'") && drift.includes('Checking is read-only'), 'Policy drift must be presented as understandable Jellyfin access consistency with read-only check semantics');
assert(drift.includes('Reapply expected access…') && drift.includes('placeholder="RECONCILE"'), 'Reapplying expected Jellyfin access must require deliberate typed confirmation');
assert(!drift.includes('type="hidden" name="confirmation" value="RECONCILE"'), 'Access consistency must not hide the reconciliation confirmation in a one-click form');
assert(drift.includes("ui.detailDisclosure({title:'Automatic check cadence'"), 'Low-level access-consistency cadence must remain advanced detail');

assert(migrations.includes('Customer move control room') && migrations.includes('Move check passed'), 'Customer moves must retain current move health and an explicit safe preflight');
assert(migrations.includes('placeholder="ROLLBACK"') && migrations.includes('Rollback to original server'), 'Migration rollback must require typed ROLLBACK confirmation');
assert(!migrations.includes('type="hidden" name="confirmation" value="ROLLBACK"'), 'Migration rollback must not remain a one-click hidden-confirmation action');
assert(migrations.includes("ui.detailDisclosure({title:'Customer move history'"), 'Routine customer move history must be progressively disclosed');

assert(serverControl.includes('Placement ready') && serverControl.includes('fleetSummary(data.rows, data.settings)'), 'Servers must retain canonical current placement readiness');
assert(serverControl.includes('placementReason(server, settings)') && serverControl.includes('Health, sellable stream capacity, placement and library maintenance in one place.'), 'Servers must show placement eligibility/blockers alongside current fleet state');
assert(serverControl.includes('placementForm(req, server)') && serverControl.includes('>Active</option>') && serverControl.includes('>Drain</option>') && serverControl.includes('>Maintenance</option>'), 'Server placement mode must be an inline compact setting rather than a separate workflow');
assert(serverControl.includes('operatorDetails') && serverControl.includes('Placement health policy') && serverControl.includes('Future capacity preview'), 'Advanced placement policy and simulation must remain progressively disclosed under Servers');
assert(fleetOperations.includes("res.redirect(302,forward(req,'placement'))") && fleetOperations.includes("r.post('/admin/servers/operations/server/:id/placement-mode'"), 'Legacy Fleet operations must remain a compatibility and mutation owner while its UI redirects to Servers');

for (const label of ['Customer moves','Access consistency']) {
  assert(nav.includes(`'${label}'`) && provisioningTabs.includes(`'${label}'`), `Provisioning navigation must use task language: ${label}`);
}

console.log('admin operator clarity smoke: ok');