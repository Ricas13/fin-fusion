'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const overview = read('src/platform/admin-integrations-overview.js');
const inline = read('src/platform/admin-integrations-inline.js');
const css = read('public/css/admin-integrations-inline.css');
const capability = read('public/css/admin-capability.css');

for (const provider of ['stripe', 'paypal', 'plisio']) {
    assert(overview.includes(`item('${provider}'`), `${provider} must remain visible in the core Connections catalogue`);
}
assert(overview.includes("item('email','Transactional email'"), 'Transactional email must remain a core Connections integration');
assert(overview.includes("const managers=Object.fromEntries(core.map(row=>[row.key,inline.manager(req,row,state,urls)]))"), 'Core integrations must render their manager inside the Connections page');
assert(overview.includes("row.core?`#integration-${row.key}`:row.href"), 'Core repair/manage navigation must target the inline manager rather than another page');
assert(overview.includes('configured / ${optional.length} available'), 'Optional integration disclosure must summarize configured versus available services');
assert(overview.includes('integrationOverviewStatus good') && overview.includes('✓</span>Ready'), 'Ready state must use the compact status treatment');
assert(overview.includes('integrationHealthRow'), 'Integration health rows must use the padded shared treatment');

for (const route of [
    '/admin/settings/integrations/payments/:provider/test',
    '/admin/settings/integrations/payments/:provider',
    '/admin/settings/integrations/email/settings',
    '/admin/settings/integrations/email/test',
    '/admin/settings/integrations/email/send-test'
]) assert(inline.includes(route), `Connections inline route missing: ${route}`);

assert(inline.includes("PAYMENT_PROVIDERS = Object.freeze(['stripe', 'paypal', 'plisio'])"), 'Connections payment management must cover Stripe, PayPal and Plisio uniformly');
assert(inline.includes('Test connection'), 'Core payment/email panels must expose connection tests inline');
assert(inline.includes('Send test email'), 'Transactional email must expose a test-email action inline');
assert(inline.includes('data-native-submit="true"'), 'Sensitive inline configuration forms must preserve normal browser POST/redirect behavior');
assert(inline.includes("row.issue ? ' open' : ''"), 'An enabled but incomplete integration must open its repair panel immediately');
assert(inline.includes('There is no hidden global default; each plan’s provider mappings decide which checkout options are offered.'), 'Connections must explain the real checkout-provider selection model instead of inventing a primary provider');
assert(!inline.includes('return `<label class="integrationInlineField"><span>${esc(label)}</span><input class="input" type="password"'), 'Secret fields must not nest a label inside another label');
assert(inline.includes('return `<div class="integrationInlineField"><span>${esc(label)}</span><input class="input" type="password"'), 'Secret field wrapper must use valid non-label markup around the clear checkbox label');

assert(capability.includes("@import url('/css/admin-integrations-inline.css');"), 'Connections inline styles must load after the shared admin responsive layers');
assert(css.includes('.integrationOverviewCoreCard:first-child{border-top:1px solid var(--border)}'), 'Core rows must keep deliberate vertical separation');
assert(css.includes('padding:16px 4px'), 'Core service rows need enough vertical padding to keep copy clear of dividers');
assert(css.includes('.integrationOverviewOptionalGrid{grid-template-columns:repeat(3,minmax(0,1fr))'), 'Optional integrations should use three cards across where space permits');
assert(css.includes('@media(max-width:1100px)') && css.includes('repeat(2,minmax(0,1fr))'), 'Optional/configuration grids must collapse to two columns at medium widths');
assert(css.includes('@media(max-width:760px)') && css.includes('grid-template-columns:1fr'), 'Connections must collapse to one column on narrow screens');

console.log('admin inline integrations management smoke: ok');
