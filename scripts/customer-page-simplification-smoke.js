'use strict';

// The customer page must stay simple: one collapsible component, stable anchors that
// ?tab= links can open, four header tiles, no duplicate entry points, and popover forms
// that dismiss. This renders the real page body and checks the shipped client script.

require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const view = require('../src/platform/customer-360-view');

function fixture(overrides = {}) {
  return {
    customer: { id: 'cust-1', display_name: 'Test Customer', login_username: 'testcustomer', login_email: 'test@example.invalid', registration_source: 'direct' },
    accounts: [], activeHolds: [],
    subscriptions: [{ status: 'active', current_period_end: new Date(Date.now() + 86400000), plan_name: 'Test Plan', streams: 1, service_type: 'jellyfin', server_class: 'premium', price_minor: 999, currency: 'GBP', source: 'stripe' }],
    activeStreams: [], activitySummary: { last_playback_at: null, watch_seconds_30d: 0, sessions_30d: 0 }, downloadSummary: { downloads_30d: 0 },
    playback: [], runs: [], primaryEntitlement: null, provisioningState: null, manualPayments: [], paymentCustomers: [], downloads: [], policyEvents: [], authSessions: [], authEvents: [], audit: [], requests: [], timeline: [],
    ...overrides
  };
}

(async () => {
  const html = await view.body(fixture(), 'token', {});

  // One fold component, with stable anchors for deep links.
  const folds = html.match(/<details class="opDisclosure opFold/g) || [];
  assert(folds.length >= 5, `every collapsible section must use the single fold component (found ${folds.length})`);
  assert(!html.includes('<details class="customer360Group'), 'the old group collapsibles must not return');
  for (const id of ['customer-payments', 'customer-activity', 'customer-playback', 'customer-logs', 'customer-destructive']) {
    assert(html.includes(`id="${id}"`), `missing stable anchor ${id}`);
  }
  assert(/<summary><span class="opFoldTitle">[^<]+<\/span><small>[^<]*<\/small><span class="opChevron"/.test(html), 'folds must show title, a one-line summary and a chevron');

  // Payments is a first-class section next to the essentials, not buried under diagnostics.
  assert(html.indexOf('id="customer-payments"') < html.indexOf('History &amp; diagnostics') || html.indexOf('id="customer-payments"') < html.indexOf('History & diagnostics'), 'Payments must come before the read-only diagnostics');
  // The five working cards sit in one row, in working order, and are never collapsed.
  const order = ['<h2>Customer portal</h2>', '<h2>Plans</h2>', '<h2>Jellyfin</h2>', '<h2>Stremio</h2>', '<h2>Request service</h2>'].map(title => html.indexOf(title));
  assert(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `cards must be ordered Portal, Plans, Jellyfin, Stremio, Request service (${order})`);
  assert(!html.includes('Other services') && !html.includes('<h2>Discord</h2>'), 'Stremio and Request service must not be collapsed, and the Discord card is replaced by the Edit button');
  const portal = html.slice(html.indexOf('<h2>Customer portal</h2>'), html.indexOf('<h2>Plans</h2>'));
  assert(portal.includes('Access holds') && portal.includes('Add suspension') && portal.includes('Discord'), 'access holds and the Discord link status must live in the Customer portal card');

  // Header: billing is one tile; the glance row no longer repeats plan/media/holds.
  assert(html.includes('<small>Billing</small>') && !html.includes('<small>Total renewal</small>') && !html.includes('<small>Next renewal</small>'), 'the hero must carry one Billing tile');
  assert(!html.includes('<span>Media access</span>') && !html.includes('<span>Access holds</span>'), 'tiles that duplicate the cards below must be gone');

  // A one-click "Fix / reconcile access" is visible in the cards and nothing hides it.
  const cardsHtml = html.slice(html.indexOf('customer360Essentials'), html.indexOf('id="customer-payments"'));
  assert((cardsHtml.match(/\/manage\/reconcile"/g) || []).length === 1 && cardsHtml.includes('Fix / reconcile access'), 'exactly one visible Fix / reconcile access control must be in the cards');
  assert(!/manage\/reconcile"\]\{display:none/.test(read('public/js/admin-customer-primary-actions.js') + read('src/platform/admin-customer-primary-actions.js')), 'no stylesheet may hide the reconcile control');

  // One entry point for adding a plan; no second inline form in the Plans card.
  assert(!html.includes('<summary>Add plan manually…</summary>'), 'the Plans card must not carry a second inline "Add plan manually" form');

  // Consistent names.
    const compact = require('../src/platform/customer-360-compact');
  const embyCard = compact.mediaCard(fixture(), 'token', [{ jellyfin_username: 'e', media_server_type: 'emby', server_name: 'E', disabled: false }], { authority: 'automatic' });
  assert(embyCard.includes('<h2>Jellyfin / Emby</h2>'), 'the card keeps the Emby name when an Emby account exists');

  // Stylesheet is linked and sized for reading.
  assert(html.includes('/css/admin-customer-folds.css'), 'fold stylesheet must be linked');
  const css = read('public/css/admin-customer-folds.css');
  assert(/font-size:\.74rem!important/.test(css), 'action buttons must be readable');
  assert(/\.customerClaimInviteQuickResult\[hidden\]\{display:none!important\}/.test(css), 'the empty invite-URL row must stay hidden');

  // Client script: tab/hash deep links, popover dismissal, admin tools placement.
  const js = read('public/js/admin-customer-primary-actions.js');
  assert(js.includes("billing:'customer-payments'") && js.includes('openRequestedSection'), '?tab=billing must open and scroll to Payments');
  assert(!js.includes("'customer-services'"), 'the Other services section no longer exists');
  assert(!js.includes("access:'customer-jellyfin'"), '?tab=access must not scroll away from the notice banner');
  assert(js.includes("event.key!=='Escape'") && js.includes('wirePopoverDismiss') && js.includes('?.focus()'), 'popover forms must close on Escape and outside click, returning focus to the opener');
  assert(js.includes('prefers-reduced-motion'), 'scripted scrolling must respect reduced motion');
  assert(js.includes('[data-customer-admin-tools]') && html.includes('data-customer-admin-tools'), 'recovery tools must sit with the destructive actions');
  assert(js.includes("document.querySelector('#customer-jellyfin .opActions')"), 'Make permanent / Return to automation must live in the Jellyfin card');
})()
  .then(() => console.log('customer page simplification smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exit(1); });
