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
const navModel = require('../src/platform/admin-nav');
const css = read('public/css/admin-server-control.css');
const capability = read('public/css/admin-capability.css');

assert(fleet.includes('Health, sellable stream capacity, placement and library maintenance in one place.'), 'Servers must be the consolidated fleet control surface');
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
assert(navModel.hiddenPages['fleet-operations']?.parentKey==='servers' && navModel.hiddenPages.libraries?.parentKey==='servers', 'Placement and Libraries compatibility routes must remain owned by the consolidated Servers control surface');
assert.deepStrictEqual(navModel.childPages('servers'), [], 'Servers rail must stay two levels deep');
assert.deepStrictEqual(navModel.viewsFor('servers').map(page=>page[1]), ['Fleet dashboard','Placement & capacity'], 'durable Servers views must stay discoverable from their parent without becoming rail children');
assert(navModel.relatedPages('servers').some(page=>page[0]==='libraries'), 'Libraries must remain discoverable as a parent-owned related page');
assert(navModel.SIDEBAR_EXCLUDED_CHILDREN.has('libraries'), 'Libraries must remain a direct compatibility utility without occupying permanent sidebar navigation');
assert(navModel.aliases.operations==='servers' && !navModel.aliases['fleet-operations'] && !navModel.aliases.libraries, 'legacy Operations may resolve to Servers while Placement/Libraries retain exact contextual identity');

assert(capability.includes("@import url('/css/admin-server-control.css')"), 'shared admin shell must load server control styling');
assert(css.includes('.serverControlTable') && css.includes('.serverControlOverview') && css.includes('.serverAdvancedGrid'), 'consolidated Servers needs dedicated compact layout contracts');

console.log('server control consolidation checks passed.');
