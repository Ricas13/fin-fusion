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

for (const primitive of ['operatorHero', 'resolutionCard', 'detailDisclosure']) {
  assert(ui.includes(`function ${primitive}`), `shared admin UI must expose ${primitive}`);
  assert(ui.includes(primitive), `shared admin UI exports must include ${primitive}`);
}
for (const tone of ['operatorHero-good', 'operatorHero-warn', 'operatorHero-bad', 'operatorHero-commerce', 'operatorHero-streaming']) {
  assert(css.includes(tone), `operator clarity CSS must define ${tone}`);
}
assert(capability.includes("@import url('/css/admin-operator-clarity.css')"), 'operator clarity CSS must load through canonical admin capability bundle');

assert(dashboard.includes('Operator control room') && dashboard.includes('Do this next'), 'main dashboard must present operator-first state and next action');
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

console.log('admin operator clarity smoke: ok');
