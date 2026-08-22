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

console.log('admin operator clarity smoke: ok');
