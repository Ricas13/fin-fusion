'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const ui=read('src/platform/admin-ui.js');
const plans=read('src/platform/admin-plans-list.js');
const payments=read('src/platform/admin-payment-settings.js');
const customers=read('src/platform/admin-users-dashboard.js');
const user=read('src/platform/admin-user-detail.js');
const playback=read('src/platform/admin-playback-dashboard.js');
const playbackView=read('views/admin/playback.ejs');
const provisioning=read('src/platform/admin-provisioning-control.js');
const drift=read('src/platform/admin-policy-drift.js');
const migrations=read('src/platform/admin-migrations.js');
const serverControl=read('src/platform/admin-server-fleet-dashboard.js');
const fleetOperations=read('src/platform/admin-fleet-operations.js');
const nav=read('src/platform/admin-nav.js');
const provisioningTabs=read('src/platform/admin-provisioning-tabs.js');

assert(ui.includes('PAGE_STATUS_HERO_ENABLED = false'), 'Large page-level status heroes must be retired by default');
assert(ui.includes('operatorHeroActions-compact'), 'Retired status heroes must preserve any actions in compact form');
assert(!plans.includes("ui.detailDisclosure({title:'Plan policies & storefront tools'"), 'Plans must not hide primary catalogue tools behind a policies disclosure');
assert(!plans.includes('data-plan-filters') && !plans.includes('data-plan-search'), 'Plans must open directly on its small catalogue without filter/search chrome');
assert(plans.includes("String(req.query.archived || '') === '1'") && plans.includes('Archived Plans'), 'Archived plan versions must remain retrievable outside the active catalogue');

assert(payments.includes('integrationCard') || payments.includes('integration-card'), 'Payments must retain provider integration cards');
assert(payments.includes('Stripe') && payments.includes('PayPal'), 'Payments must retain Stripe and PayPal provider controls');

assert(customers.includes('Customer') && customers.includes('Customers'), 'Customers dashboard must remain customer-first');
assert(user.includes('Customer') || user.includes('customer'), 'Customer detail must remain understandable as customer administration');

assert(playback.includes('Playback') && playbackView.includes('Playback'), 'Playback must retain a clear operator-facing purpose');
assert(!playbackView.includes('remote_endpoint') && !playbackView.includes('jellyfin_session_id'), 'Playback UI must not expose raw network endpoints or Jellyfin session identifiers');

assert(provisioning.includes('Provisioning control room') && provisioning.includes('Fix these customer access problems first'), 'Provisioning must retain failed/blocked customer-access state');
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
