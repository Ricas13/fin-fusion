'use strict';

// Customer page: the merged activity log and the lane tabs. Pure (no database): ordering, labels, noise filtering, escaping,
// and that nothing needs a script.
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'customer-timeline-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const timeline = require('../src/platform/customer-360-timeline');
const accessCards = require('../src/platform/customer-360-access-cards');

const at = minutes => new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + minutes * 60000).toISOString();

const entries = timeline.build({
    auth: [
        { event_type: 'login.password_accepted', success: true, created_at: at(1) },
        { event_type: 'login.session_created', success: true, created_at: at(2) },
        { event_type: 'login.password_failed', success: false, created_at: at(3) },
        { event_type: 'password.changed', success: true, created_at: at(4) },
        { event_type: 'something.new_unknown', success: false, created_at: at(5) }
    ],
    audit: [
        { action: 'admin.customer.ban', created_at: at(6), actor_name: 'ricas', metadata: { reason: 'chargeback abuse' } },
        { action: 'admin.activity.view', created_at: at(7), actor_name: 'ricas', metadata: {} },
        { action: 'admin.dashboard.layout.update', created_at: at(8), actor_name: 'ricas', metadata: {} },
        { action: 'admin.customer.some_future_action', created_at: at(9), actor_name: '', metadata: null }
    ],
    payments: [
        { transaction_type: 'payment', transaction_status: 'completed', gross_amount_minor: 1500, currency: 'GBP', provider: 'stripe', occurred_at: at(10) },
        { transaction_type: 'refund', transaction_status: 'completed', gross_amount_minor: 500, currency: 'GBP', provider: 'stripe', occurred_at: at(11) }
    ],
    incidents: [
        { incident_type: 'failed_renewal', incident_status: 'open', provider: 'paypal', amount_minor: 1500, currency: 'GBP', created_at: at(12), resolved_at: null }
    ],
    runs: [
        { action: 'emby_disable', status: 'succeeded', started_at: at(13) },
        { action: 'reconcile', status: 'failed', started_at: at(14) },
        { action: 'no_timestamp', status: 'succeeded' }
    ]
});

assert.deepStrictEqual(entries.map(entry => entry.at), entries.map(entry => entry.at).slice().sort((a, b) => new Date(b) - new Date(a)), 'newest first');
assert(!entries.some(entry => entry.title.toLowerCase().includes('activity view') || entry.title.includes('Dashboard')), 'view-tracking noise is dropped');
assert(!entries.some(entry => entry.at === at(1)), 'password_accepted is dropped (it always precedes a session event)');
assert(!entries.some(entry => !entry.at), 'entries without a timestamp are dropped');
const byTitle = title => entries.find(entry => entry.title === title);
assert(byTitle('Signed in to the portal'), 'sign-ins are labelled');
assert.strictEqual(byTitle('Failed sign-in (wrong password)').tone, 'bad', 'failed sign-ins are flagged');
assert(byTitle('Portal password changed'), 'password changes are labelled');
assert(entries.find(entry => entry.title === 'Something · new unknown' && entry.tone === 'bad'), 'unknown failed security events still show, flagged');
const ban = byTitle('Customer banned');
assert.strictEqual(ban.detail, 'by ricas · chargeback abuse', 'admin changes name the actor and any reason');
assert(entries.find(entry => entry.title === 'Customer · some future action' || entry.title === 'Some future action'), 'unknown admin actions are humanised, never dropped');
assert(entries.find(entry => entry.category === 'payment' && entry.title === 'Payment · completed' && entry.detail.includes('£15.00') && entry.tone === 'good'), 'payments show amount and provider');
assert.strictEqual(entries.find(entry => entry.title === 'Refund · completed').tone, 'warn', 'refunds are flagged');
const incident = entries.find(entry => entry.title === 'Payment incident: failed renewal');
assert(incident && incident.tone === 'bad' && incident.detail.includes('open'), 'open payment incidents are flagged');
assert.strictEqual(entries.find(entry => entry.title === 'Reconcile').tone, 'bad', 'failed service runs are flagged');

// Payment status classification: settled is green, pending/unknown is neutral, failed is red, adverse is amber.
const tone = (type, status) => timeline.build({ payments: [{ transaction_type: type, transaction_status: status, gross_amount_minor: 100, currency: 'GBP', provider: 'x', occurred_at: at(1) }] })[0].tone;
for (const status of ['succeeded', 'completed', 'COMPLETED', 'S', 'paid']) assert.strictEqual(tone('payment', status), 'good', `${status} is settled`);
for (const status of ['pending', 'new', 'unpaid', 'processing', 'P', 'something_new', '']) assert.strictEqual(tone('payment', status), '', `${status || '(none)'} is never shown as a success`);
for (const status of ['failed', 'declined', 'denied', 'D', 'error']) assert.strictEqual(tone('payment', status), 'bad', `${status} is a failure`);
assert.strictEqual(tone('refund', 'completed'), 'warn');
assert.strictEqual(tone('refund', 'failed'), 'bad', 'a failed refund is a failure, not just adverse');
assert.strictEqual(tone('payment', 'V'), 'warn', 'a PayPal reversal is adverse');
assert.strictEqual(tone('refund', 'pending'), 'warn', 'a pending refund is still flagged');
assert.strictEqual(tone('payment', 'disputed'), 'warn');
assert.strictEqual(tone('chargeback', 'new'), 'warn');

// Service runs keep their completion time.
const run = timeline.build({ runs: [{ action: 'reconcile', status: 'succeeded', started_at: at(0), completed_at: at(3) }, { action: 'emby_disable', status: 'running', started_at: at(5), completed_at: null }] });
assert(run.find(entry => entry.title === 'Reconcile').detail.includes('finished') && run.find(entry => entry.title === 'Reconcile').detail.includes('took 3m'), 'a finished run shows when it finished and how long it took');
assert(run.find(entry => entry.title === 'Emby disable').detail.includes('not finished'), 'an unfinished run says so');

// Durations never read '1h 60m'.
const took = seconds => timeline.build({ runs: [{ action: 'x', status: 'ok', started_at: at(0), completed_at: new Date(new Date(at(0)).getTime() + seconds * 1000).toISOString() }] })[0].detail;
assert(took(7185).includes('took 2h 00m') && !took(7185).includes('60m'), '1h 59m 45s rounds to 2h 00m, never 1h 60m');
assert(took(3599).includes('took 1h 00m'), '59m 59s rounds up to 1h 00m');
assert(took(45).includes('took 45s') && took(600).includes('took 10m') && took(5400).includes('took 1h 30m'));

// An interrupted outside refund (progress markers, no completed/failed entry) stays visible; a finished one does not duplicate.
const interrupted = timeline.build({ audit: [
    { id: 1, action: 'billing.refund.recorded_externally', created_at: at(1), actor_name: 'ricas', metadata: { submissionId: 'sub-1' } },
    { id: 2, action: 'billing.refund.recorded_externally_effect', created_at: at(2), actor_name: 'ricas', metadata: { submissionId: 'sub-1' } },
    { id: 3, action: 'billing.refund.recorded_externally', created_at: at(3), actor_name: 'ricas', metadata: { submissionId: 'sub-2' } },
    { id: 4, action: 'billing.refund.recorded_externally_completed', created_at: at(4), actor_name: 'ricas', metadata: { submissionId: 'sub-2' } }
] });
assert.deepStrictEqual(interrupted.map(entry => entry.title).sort(), ['Refund made outside the app is not finished', 'Refund made outside the app was recorded'].sort(), 'only the unfinished refund shows as unfinished; the finished one shows once as recorded');
assert.strictEqual(interrupted.find(entry => entry.title.endsWith('not finished')).tone, 'warn');
assert.strictEqual(interrupted.find(entry => entry.title.endsWith('not finished')).at, at(2), 'dated at its last step');

// Outside refunds: the completed entry is shown, its internal progress markers are not.
const refunds = timeline.build({ audit: [
    { action: 'billing.refund.recorded_externally', created_at: at(1), actor_name: 'ricas', metadata: {} },
    { action: 'billing.refund.recorded_externally_effect', created_at: at(2), actor_name: 'ricas', metadata: {} },
    { action: 'billing.refund.recorded_externally_completed', created_at: at(3), actor_name: 'ricas', metadata: { reason: 'refunded in Stripe' } },
    { action: 'billing.refund.recorded_externally_failed', created_at: at(4), actor_name: 'ricas', metadata: {} },
    { action: 'admin.customer.manual_grant', created_at: at(5), actor_name: 'ricas', metadata: { note: 'paid by bank transfer' } }
] });
assert(refunds.some(entry => entry.title === 'Refund made outside the app was recorded') && refunds.some(entry => entry.title === 'Plan added manually'), 'refund completion and manual grants are shown');
assert.strictEqual(refunds.filter(entry => entry.title.toLowerCase().includes('recorded externally')).length, 0, 'internal progress markers are hidden');
assert.strictEqual(refunds.find(entry => entry.title.includes('failed')).tone, 'bad', 'a failed outside-refund is flagged');

// Cap
const many = timeline.build({ audit: Array.from({ length: timeline.MAX_ENTRIES + 40 }, (_, i) => ({ action: 'admin.customer.ban', created_at: at(i), actor_name: 'x', metadata: {} })) });
assert.strictEqual(many.length, timeline.MAX_ENTRIES, 'the log is capped');

// Rendering: escaped, filterable without script, and an honest empty state.
const html = timeline.render(timeline.build({ audit: [{ action: 'admin.customer.ban', created_at: at(1), actor_name: '<img src=x onerror=alert(1)>', metadata: { reason: '"><script>alert(1)</script>' } }] }));
const withoutEscapedText = html.replace(/&lt;.*?&gt;/g, '');
assert(!html.includes('<script') && !html.includes('<img'), 'values are escaped: no raw tags from data');
assert(html.includes('&lt;img') && html.includes('&lt;script'), 'the hostile text is shown as text');
assert(!/<[^>]*\son[a-z]+=/i.test(withoutEscapedText), 'no event-handler attributes');
for (const key of ['all', 'security', 'admin', 'payment', 'service']) assert(html.includes(`-${key}"`) && html.includes(`for=tl`), `filter ${key} exists`);
assert(html.includes('<fieldset class="tlWrap"><legend class="tlLegend">'), 'the radios sit in a labelled fieldset');
assert(timeline.render([]).includes('No activity recorded yet.'), 'empty state');
const fixed = timeline.render([], { idPrefix: 'fixedlog' });
assert(fixed.includes('#fixedlog-payment:checked ~ .tlRows .tlRow:not(.tl-payment){display:none}'), 'the filter is pure CSS and scoped to its own prefix');
assert(fixed.includes('#fixedlog-payment:focus-visible ~ .tlBar label[for=fixedlog-payment]'), 'the focused chip gets a visible focus ring');
// Two logs on one page never share ids, names or selectors.
const first = timeline.render([]), second = timeline.render([]);
const ids = markup => [...markup.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
assert(ids(first).length === 5 && ids(second).length === 5, 'five filter radios each');
assert(ids(first).every(id => !ids(second).includes(id)), 'no id is shared between two renderings');
assert(first.match(/name="([^"]+)"/)[1] !== second.match(/name="([^"]+)"/)[1], 'radio group names differ');

// Lane tabs: none for a single lane; one tab per lane otherwise; pure CSS; unique per call; no cap.
assert.strictEqual(accessCards.laneTabs([{ label: 'Premium', html: '<p>only</p>' }]), '<p>only</p>', 'a single lane shows no tabs');
const tabs = accessCards.laneTabs([{ label: 'Premium · Gold', html: '<p>one</p>' }, { label: 'Free Server', html: '<p>two</p>' }]);
assert(tabs.includes('Premium · Gold') && tabs.includes('Free Server') && (tabs.match(/class="laneRadio"/g) || []).length === 2, 'one tab per lane');
assert(tabs.includes('<p>one</p>') && tabs.includes('<p>two</p>'), 'every lane stays in the page (forms keep working)');
assert(tabs.includes('<fieldset class="laneTabs"><legend class="laneLegend">Service lane</legend>'), 'the tabs are a labelled radio group');
assert(!tabs.includes('<script') && !/\son[a-z]+=/i.test(tabs.replace(/<style>.*?<\/style>/g, '')), 'no script needed');
const seven = accessCards.laneTabs(Array.from({ length: 7 }, (_, index) => ({ label: `Lane ${index}`, html: `<form>lane-${index}</form>` })));
for (let index = 0; index < 7; index++) assert(seven.includes(`<form>lane-${index}</form>`) && seven.includes(`Lane ${index}`), `lane ${index} is not dropped (no cap)`);
const again = accessCards.laneTabs([{ label: 'A', html: 'a' }, { label: 'B', html: 'b' }]);
const laneIds = markup => [...markup.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
assert(laneIds(tabs).every(id => !laneIds(again).includes(id)), 'two tab sets on one page never share ids');
assert(seven.includes(':nth-child(7)'), 'there is a display rule for the seventh panel');
assert(accessCards.styles().includes('.threeCol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'), 'access, libraries and requests are three columns');
assert(!/laneTab-\d/.test(accessCards.styles()), 'no fixed-id rules remain in the shared stylesheet');

// Library and setting names keep their full text available when the column is narrow.
const cardsSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/platform/customer-360-access-cards.js'), 'utf8');
assert(!/<span class="lbl">\$\{esc\(/.test(cardsSource), 'every dense-row label has a title with the full name');

console.log('customer timeline smoke: ok');
