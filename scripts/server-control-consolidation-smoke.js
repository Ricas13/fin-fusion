'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const fleet = read('src/platform/admin-server-fleet-dashboard.js');
const operations = read('src/platform/admin-fleet-operations.js');
const libraries = read('src/platform/admin-libraries.js');
const serverTabs = read('src/platform/admin-server-tabs.js');
const nav = read('src/platform/admin-nav.js');
const css = read('public/css/admin-server-control.css');
const capability = read('public/css/admin-capability.css');

assert(fleet.includes('Health, capacity, placement and library maintenance in one place.'), 'Servers must be the consolidated fleet control surface');
assert(fleet.includes('/admin/servers/operations/server/${esc(server.id)}/placement-mode'), 'server rows must own inline placement controls');
assert(fleet.includes('/admin/libraries/${esc(server.id)}/refresh'), 'server rows must expose library Scan');
assert(fleet.includes('>Active</option>') && fleet.includes('>Drain</option>') && fleet.includes('>Maintenance</option>'), 'placement selects must use compact labels');
assert(!fleet.includes('Active — can receive new placements'), 'verbose placement prose must stay out of table controls');
assert(fleet.includes('Placement health policy') && fleet.includes('Future capacity preview'), 'advanced placement tools must remain available on Servers');
assert(fleet.includes('operatorDetails'), 'advanced placement tools must be collapsed disclosures');

assert(operations.includes("res.redirect(302,forward(req,'placement'))"), 'legacy Fleet operations GET must redirect to Servers');
assert(operations.includes('/admin/servers?message=') && operations.includes('#capacity-preview'), 'legacy placement mutations/previews must return to Servers');
assert(libraries.includes('/admin/servers?message=') && libraries.includes('#server-'), 'library scans must return to the originating server row');

assert(!serverTabs.includes("['libraries','Libraries'"), 'per-server tabs must not expose a separate Libraries workflow');
assert(!nav.includes("'fleet-operations':Object.freeze") && !nav.includes("libraries:Object.freeze({groupKey:'jellyfin',parentKey:'servers'"), 'Servers workflow must not advertise Placement or Libraries as siblings');
assert(nav.includes("'fleet-operations':'servers','libraries':'servers'"), 'legacy pages must still resolve visually to Servers');

assert(capability.includes("@import url('/css/admin-server-control.css')"), 'shared admin shell must load server control styling');
assert(css.includes('.serverControlTable') && css.includes('.serverControlOverview') && css.includes('.serverAdvancedGrid'), 'consolidated Servers needs dedicated compact layout contracts');

console.log('server control consolidation checks passed.');
