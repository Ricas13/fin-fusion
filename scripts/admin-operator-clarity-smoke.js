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
const customer360 = read('src/platform/customer-360-view.js');
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
const provisioningTabs = read('src/platform/provisioning-workflow-tabs.js');
const nav = read('src/platform/admin-nav.js');
const routes = read('src/platform/admin-route-composition.js');

for (const primitive of ['operatorHero', 'resolutionCard', 'detailDisclosure']) {
  assert(ui.includes(`function ${primitive}`), `shared admin UI must expose ${primitive}`);
  assert(ui.includes(primitive), `shared admin UI exports must include ${primitive}`);
}
assert(ui.includes('Do this next'), 'shared operator hero must label the recommended next action clearly');
for (const tone of ['operatorHero-good', 'operatorHero-warn', 'operatorHero-bad', 'operatorHero-commerce', 'operatorHero-streaming']) {
  assert(css.includes(tone), `operator clarity CSS must define ${tone}`);
}
assert(capability.includes("@import url('/css/admin-operator-clarity.css')"), 'operator clarity CSS must load through canonical admin capability bundle');

assert(dashboard.includes('Operator control room') && dashboard.includes('ui.operatorHero({') && dashboard.includes('next,'), 'main dashboard must use the shared operator hero and provide a recommended next action');
for (const label of ['Fix backup', 'Fix server', 'Fix automation', 'Resolve payment', 'Fix notification', 'Fix provisioning']) {
  assert(dashboard.includes(label), `dashboard attention rows must use explicit action language: ${label}`);
}
assert(attention.includes('Issue & fix') && attention.includes('actionLabel'), 'Needs Attention must present source-resolution actions, not generic source links');
assert(attention.includes('Fix the source problem first'), 'Needs Attention must distinguish fixing source problems from acknowledgement workflow');
assert(attentionSource.includes('/admin/servers/dashboard?server='), 'server attention items must preserve server context when opening the fleet control room');

assert(backups.includes('selectedResolution') && backups.includes('You came here to fix this'), 'Backups must render contextual resolution when opened from an issue');
assert(backups.includes('Verify this backup now'), 'Backups must provide an explicit verification action for the selected recovery point');
assert(backups.includes('name="runId"'), 'backup verification requests must preserve the selected recovery-point identity');
assert(backups.includes("WHERE id=$1 AND status='succeeded' AND file_path IS NOT NULL"), 'selected verification must only accept an existing successful encrypted recovery point');
assert(backups.includes('Recent recovery points') && backups.includes('Full backup history'), 'backup history must be recent-first with full history behind deliberate disclosure');
assert(backups.includes('There is intentionally no browser “Restore” button'), 'destructive recovery must remain host-side');
assert(!backups.includes("require('child_process')") && !backups.includes('exec(') && !backups.includes('spawn('), 'operator clarity must not add browser shell execution');

assert(servers.includes('Jellyfin fleet control room'), 'Servers dashboard must lead with a fleet control-room hero');
assert(servers.includes('selectedServerResolution') && servers.includes('You came here to fix this'), 'Servers dashboard must preserve and explain issue context');
assert(servers.includes('Open ${esc(server.name)} settings'), 'unhealthy server context must expose the corrective settings action');
assert(servers.includes('fleetSummary'), 'fleet hero must summarize health, streams, users and capacity from canonical fleet rows');

assert(customers.includes('Customer control room') && customers.includes('customerHero(ctx)'), 'Customers dashboard must lead with canonical customer health before analytics');
assert(customers.indexOf('customerHero(ctx)') < customers.indexOf('rangeControls(ctx.range)'), 'Customer health must render before analytics controls');
assert(customers.includes('ctx.data.needsAttention'), 'Customer hero must reuse canonical Needs Attention data instead of creating a second exception model');

assert(automation.includes('Automation control room') && automation.includes('automationHero(jobs,worker,workerAlive)'), 'Automation must lead with worker/job health and next action');
assert(automation.includes('Fix these jobs first') && automation.includes('All automation schedules'), 'Automation must expose failures before progressively disclosed routine schedules');
assert(automation.includes("jobHealth.healthState(job)"), 'Automation clarity must reuse canonical job-health state');

assert(notifications.includes('Notification control room') && notifications.includes('Fix failed deliveries first'), 'Notifications must surface delivery failure health before configuration');
assert(notifications.includes("ui.detailDisclosure({title:'Messaging apps & credentials'") && notifications.includes('Global event catalogue'), 'Notification credentials and routing catalogue must be progressively disclosed');
assert(!notifications.includes('<th>Destination</th>'), 'Default notification history must not expose recipient destinations');
assert(notifications.includes('notificationOutbox.recent(80)'), 'Notification health must reuse the canonical outbox history');

assert(payments.includes('Payment control room') && payments.includes('Failed provider events'), 'Payments must summarize provider safety and expose failed events first');
assert(payments.includes("ui.detailDisclosure({title:'Stripe & PayPal credentials'"), 'Payment credentials must be behind deliberate disclosure');
assert(payments.includes("providerEvents=(events||[]).filter(event=>event.provider===provider)"), 'Payment hero/cards must reuse canonical provider event state');
assert(payments.includes("latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)"), 'Payment provider evidence must remain based on successfully processed events');

assert(commerce.includes('Commerce control room') && commerce.includes('Payment incidents to resolve'), 'Commerce must put customer-impacting payment work before revenue analytics');
assert(commerce.indexOf('commerceHero(d,dashboardCtx)') < commerce.indexOf('rangeControls(dashboardCtx.range)'), 'Commerce operator state must render before analytics controls');
assert(commerce.includes("d.paymentIncidents.filter(row=>!row.resolved_at)"), 'Commerce clarity must reuse canonical payment incidents');
assert(commerce.includes("ui.detailDisclosure({title:'Commercial policies & detailed payment state'"), 'Routine commercial policy/state detail must be progressively disclosed');

assert(plans.includes('Product control room') && plans.includes('planReadinessHero(rows,ctx,create)'), 'Plans must lead with actual sale readiness rather than catalogue tables');
assert(plans.includes('readiness.evaluate(plan,ctx)') && plans.includes('live_subscriber_count'), 'Plans readiness must reuse canonical product readiness and capacity state');
assert(plans.includes("ui.detailDisclosure({title:'Plan policies & storefront tools'"), 'Routine plan policy/storefront tools must be progressively disclosed');

assert(customer360.includes('Customer journey') && customer360.includes("['overview','1','Account'") && customer360.includes("['access','2','Access'") && customer360.includes("['billing','3','Billing'") && customer360.includes("['activity','4','Activity'"), 'Customer 360 must present the account → access → billing → activity journey');
assert(customer360.includes('ui.operatorHero({') && customer360.includes('activeSubscription(detail)'), 'Customer 360 journey must reuse the canonical customer detail rather than a second status model');
assert(customer360.includes("if(tab!=='access')return journeyHtml+html"), 'Customer journey must lead every Customer 360 tab');

assert(orders.includes('Transaction desk') && orders.includes('Open customer billing →'), 'Orders must act as a transaction trail into customer billing rather than a raw record table');
assert(orders.includes("ui.detailDisclosure({title:`Full purchase history"), 'Older order history must be progressively disclosed');
assert(!orders.includes('provider_subscription_id'), 'Orders must not expose provider subscription identifiers in the normal transaction view');

assert(billing.includes('Billing operations') && billing.includes('Fix these subscriptions first'), 'Billing must expose customer-impacting recurring problems before routine reconciliation');
assert(billing.includes("row.status==='past_due'||Boolean(row.last_error)"), 'Billing problems must derive from canonical subscription/provider-sync state');
assert(billing.includes("ui.detailDisclosure({title:`All recurring subscriptions"), 'Routine recurring-subscription state must be progressively disclosed');
assert(!billing.includes('<th>Provider ID</th>'), 'Billing default tables must not make raw provider identifiers an operator-facing column');

assert(support.includes('Support desk') && support.includes('Reply these first'), 'Support must lead with customer conversations waiting on staff');
assert(support.includes("['open','awaiting_staff'].includes(row.status)"), 'Support priority must reuse canonical ticket lifecycle state');
assert(support.includes("ui.detailDisclosure({title:'Ticket routing & status'"), 'Ticket routing/status controls must stay secondary to the conversation and reply action');
assert(support.includes('Internal note (staff only)'), 'Support clarity must preserve the internal-note privacy boundary');

assert(events.includes('Audit & incident trail') && events.includes('Needs investigation'), 'Audit log must surface operational failures before routine history');
assert(events.includes("row.kind==='incident')return !d.resolvedAt"), 'Audit incident severity must use canonical resolved state');
assert(events.includes("ui.detailDisclosure({title:`Full audit history"), 'Routine audit history must be progressively disclosed');
assert(!events.includes("recipient_email,'attempts'"), 'Audit queries must not pull notification recipient addresses into the combined operator trail');
assert(!events.includes("row.subject_id?' · '"), 'Audit default rendering must not print raw subject/provider identifiers');

assert(integrations.includes('Integration control room') && integrations.includes('Fix enabled integrations first'), 'Connections must lead with enabled-but-incomplete services');
assert(integrations.includes('enabled&&!configured'), 'Integration issue state must distinguish incomplete enabled services from intentionally disabled ones');
assert(integrations.includes('providerSettings.status') && integrations.includes('emailSettings.status') && integrations.includes('notificationSettings.status'), 'Connections overview must reuse canonical status providers');
assert(nav.includes("['settings-integrations','Connections','/admin/settings/integrations']"), 'Settings navigation must open the Connections integration-health control room');
assert(routes.includes('createAdminIntegrationsOverviewRouter()') && routes.indexOf('createAdminIntegrationsOverviewRouter()') < routes.indexOf('createAdminOriginalSettingsRouter()'), 'Connections overview must mount before the legacy settings owner without replacing its canonical mutation routes');

assert(playback.includes('Playback control room') && playback.includes('playbackHero(data,policy,state)'), 'Playback must lead with live operator state and a recommended next action');
assert(playback.includes('customer_stream_count') && playback.includes('overLimitCustomers'), 'Playback exceptions must derive from the canonical live-session counts and stream limits');
assert(playback.includes("decision==='stop_failed'") && playback.includes('policyEvents.safetyAttention'), 'Playback must distinguish failed enforcement from safety-blocked actions');
for (const reason of ['incomplete_server_snapshot', 'revalidation_failed', 'client_does_not_report_media_control_support']) {
  assert(playbackEvents.includes(`'${reason}'`), `shared playback policy taxonomy must include ${reason}`);
}
assert(playback.includes("require('../jellyfin/activity-policy-events')"), 'Playback operator UI must reuse the shared Jellyfin policy-event taxonomy');
assert(playbackEvents.includes('function reasonLabel') && playbackEvents.includes('function decisionLabel'), 'shared playback taxonomy must own operator-facing event labels');
assert(playbackView.includes('Fix these playback issues first') && playbackView.includes('Recent policy decisions &amp; safety checks'), 'Playback must surface current exceptions and significant decisions before routine detail');
assert(playbackView.indexOf('<%- heroHtml %>') < playbackView.indexOf('Stream policy &amp; enforcement settings'), 'Playback state must render before policy configuration');
assert(playbackView.includes('<details class="operatorDetails" id="playback-policy">'), 'Playback policy configuration must be progressively disclosed');
assert(playbackView.includes('Fleet context') && playbackView.includes('Full policy event history') && playbackView.includes('Routine playback history'), 'Fleet context and routine playback history must remain available behind deliberate disclosure');
assert(playbackView.includes('I_UNDERSTAND_THIS_STOPS_PLAYBACK'), 'Playback enforcement must preserve the explicit destructive-action acknowledgement');
assert(!playbackView.includes('remote_endpoint') && !playbackView.includes('jellyfin_session_id'), 'Playback UI must not expose raw network endpoints or Jellyfin session identifiers');

assert(provisioning.includes('Provisioning control room') && provisioning.includes('Fix these customer access problems first'), 'Provisioning must lead with failed/blocked customer access before routine state');
assert(provisioning.includes('Repair access now') && provisioning.includes("ui.detailDisclosure({title:'All customer access state'"), 'Provisioning must provide an explicit repair action and progressively disclose routine state');
assert(provisioning.includes("row.username||row.email||'CAPTAiNFiN customer'"), 'Provisioning must not fall back to rendering a raw customer UUID');
assert(provisioning.includes('Recheck all active customers') && !provisioning.includes('Queue all effective'), 'Provisioning maintenance controls must use task language rather than reconciliation jargon');

assert(drift.includes("title:'Access consistency'") && drift.includes('Checking is read-only'), 'Policy drift must be presented as understandable Jellyfin access consistency with read-only check semantics');
assert(drift.includes('Reapply expected access…') && drift.includes('placeholder="RECONCILE"'), 'Reapplying expected Jellyfin access must require deliberate typed confirmation');
assert(!drift.includes('type="hidden" name="confirmation" value="RECONCILE"'), 'Access consistency must not hide the reconciliation confirmation in a one-click form');
assert(drift.includes("ui.detailDisclosure({title:'Automatic check cadence'"), 'Low-level access-consistency cadence must remain advanced detail');

assert(migrations.includes('Customer move control room') && migrations.includes('Move check passed'), 'Customer moves must lead with current move health and an explicit safe preflight');
assert(migrations.includes('placeholder="ROLLBACK"') && migrations.includes('Rollback to original server'), 'Migration rollback must require typed ROLLBACK confirmation');
assert(!migrations.includes('type="hidden" name="confirmation" value="ROLLBACK"'), 'Migration rollback must not remain a one-click hidden-confirmation action');
assert(migrations.includes("ui.detailDisclosure({title:'Customer move history'"), 'Routine customer move history must be progressively disclosed');

assert(fleetOperations.includes('Placement control room') && fleetOperations.includes('fleetState(d)'), 'Fleet operations must lead with canonical current placement readiness');
assert(fleetOperations.includes('Eligible now') && fleetOperations.includes('Fix placement blockers first'), 'Fleet operations must show eligible capacity and blockers before configuration');
assert(fleetOperations.includes('Save mode') && !fleetOperations.includes('Set ${esc(modeLabel(x.placement_mode))}'), 'Server placement mode actions must describe the action being saved, not the old selected state');
assert(fleetOperations.includes("ui.detailDisclosure({title:'Placement health policy'"), 'Placement policy must stay secondary to current fleet readiness');

for (const label of ['Customer moves','Access consistency']) {
  assert(nav.includes(`'${label}'`) && provisioningTabs.includes(`'${label}'`), `Provisioning navigation must use task language: ${label}`);
}

console.log('admin operator clarity smoke: ok');
