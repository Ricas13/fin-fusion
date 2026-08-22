'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const routes = read('src/platform/admin-route-composition.js');
const editor = read('src/platform/admin-jellyfin-plan-editor.js');
const css = read('public/css/admin-plan-control-room.css');
const capability = read('public/css/admin-capability.css');
const attention = read('src/platform/admin-attention.js');

assert(routes.includes("createAdminJellyfinPlanEditorRouter"), 'route composition must mount the unified Jellyfin plan editor');
assert(routes.indexOf('createAdminJellyfinPlanEditorRouter()') < routes.indexOf('createAdminPlanAccessRouter()'), 'unified plan editor must own canonical Jellyfin edit/config GETs before legacy plan routes');
assert(editor.includes("router.get('/admin/plans/:id/edit'"), 'unified editor must own the canonical Jellyfin edit page');
for (const anchor of ['access', 'availability', 'delivery', 'libraries', 'commerce']) {
  assert(editor.includes(`'${anchor}'`), `unified editor must expose/redirect the ${anchor} configuration area`);
}
assert(editor.includes("if (data.free) return '';"), 'free plans must omit the commercial/payment card entirely');
assert(editor.includes('No billing cycle or payment provider applies'), 'free plan UI must explain its independence from paid commerce');
assert(editor.includes('Free plan independence:'), 'free plan editor must explicitly keep commerce outside free-plan configuration');
assert(editor.includes('editor-product') && editor.includes('editor-access') && editor.includes('editor-availability') && editor.includes('editor-delivery') && editor.includes('editor-libraries'), 'single-page plan cards must have independent save handlers');
assert(editor.includes('editor-commerce') && editor.includes('editor-payments'), 'paid Jellyfin plans must configure schedule and payment options from the unified page');
assert(editor.includes("data-jellyfin-access-model"), 'Jellyfin access card must preserve streams-vs-household policy switching');
assert(editor.includes('Maximum plan slots'), 'availability must be configurable directly in the unified editor');
assert(editor.includes('Delivery & server placement'), 'server class and placement must be configured in the unified editor');
assert(editor.includes('Library access'), 'library access must be configured in the unified editor');
assert(capability.includes("@import url('/css/admin-plan-control-room.css')"), 'shared admin shell must load the plan/attention layout corrections');
assert(css.includes('.planControlGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'), 'plan editor must use a compact three-column card grid on wide screens');
assert(css.includes('.attentionBulkBar .input.compact,.attentionActionGrid .input.compact{min-width:0!important'), 'attention workflow inputs must be allowed to shrink instead of forcing horizontal overflow');
assert(css.includes('.attentionActionGrid{grid-template-columns:minmax(92px'), 'attention row workflow must use bounded responsive columns');
assert(attention.includes('responsiveTable attentionTable'), 'Needs Attention table must opt into the constrained workflow layout');

console.log('unified plan control room smoke: ok');
