'use strict';

// The customer/revenue integrity alert (Discord / email / Telegram) and the Automation page: plain language, the customer's name and a
// link instead of database ids, what to check, and a drift guard so every alert kind in the code has guidance.
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const guidance = require('../src/automation/integrity-guidance');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// 1. Drift guard: every kind raised anywhere has an entry, with a title, a meaning and an action.
const kinds = new Set();
for (const file of ['src/automation/revenue-integrity.js', 'src/access/access-integrity.js']) {
    for (const match of read(file).matchAll(/finding\(\s*'([a-z_]+)'/g)) kinds.add(match[1]);
}
assert(kinds.size >= 25, `found the alert kinds in the source (${kinds.size})`);
for (const kind of kinds) {
    const entry = guidance.GUIDANCE[kind];
    assert(entry, `alert kind "${kind}" has no plain-language guidance in integrity-guidance.js`);
    assert(entry.title && entry.meaning && entry.action, `guidance for "${kind}" needs a title, a meaning and an action`);
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(`${entry.title}${entry.meaning}${entry.action}`), `guidance for "${kind}" must not contain ids`);
}
for (const kind of Object.keys(guidance.GUIDANCE)) assert(kinds.has(kind), `guidance for "${kind}" has no matching alert in the code (stale entry)`);

// 2. The two alerts from the screenshots, with real-looking ids.
const accountId = '45825a49-392c-4dd4-b5a0-d0d5b5f34ef2';
const entitlementId = 'b6f434fe-6dd4-4ccb-95ac-91cc40825bac';
const subscriptionId = 'b866df2a-3bb2-4022-8dd2-799905bba1aa';
const customerA = '11111111-2222-4333-8444-555555555555';
const customerB = '66666666-7777-4888-8999-000000000000';
const customers = new Map([
    [customerA, { display_name: 'Jane Smith', email: 'jane@example.com' }],
    [customerB, { display_name: 'Matt', email: 'matt@example.com' }]
]);
const findings = [
    { kind: 'primary_server_without_plan', id: accountId, customerId: customerA, detail: `Primary Jellyfin account ${accountId} exists without a live non-Free Jellyfin entitlement.` },
    { kind: 'stremio_active_without_effective_subscription', id: entitlementId, customerId: customerB, detail: `Stremio entitlement ${entitlementId} is still active even though subscription ${subscriptionId} is no longer an effective unblocked Stremio entitlement.` }
];
const alert = guidance.buildAlert(findings, { customers, baseUrl: 'https://portal.example.com/' });
assert(alert.text.includes('Jane Smith <jane@example.com>') && alert.text.includes('Matt <matt@example.com>'), 'the customer is named (name and email)');
assert(alert.text.includes(`https://portal.example.com/admin/users/${customerA}`), 'with a link to open them (no double slash)');
assert(!alert.text.includes('//admin'), 'the link has no double slash');
assert(alert.text.includes('Jellyfin account with no paid plan') && alert.text.includes('Stremio still switched on after the plan ended'), 'each problem has a plain title');
assert((alert.text.match(/What to do:/g) || []).length === 2, 'each problem says what to do');
assert(alert.text.includes('ref 45825a49') && alert.text.includes('ref b6f434fe'), 'a short reference remains for finding it in the logs');
assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(alert.text.replace(/https?:\/\/\S+/g, '')), 'no full database ids appear in the message (only inside the open-customer links)');
assert(!alert.text.includes(subscriptionId), 'the subscription id is not shown');
assert(alert.needsAction === true && alert.subject.startsWith('Needs attention:'), 'a problem that does not fix itself says it needs attention');
assert(alert.customerIds.length === 2 && alert.singleCustomerId === null, 'two customers means no single "Open customer" button');
assert(alert.text.length <= 3800, 'fits a Discord embed');
assert(guidance.buildAlert([findings[0]], { customers, baseUrl: 'https://p.example' }).singleCustomerId === customerA, 'one customer gets the Open customer button');

// 3. Self-healing only: calmer subject, and the "usually clears" note; action-needed items sort first.
const calm = guidance.buildAlert([{ kind: 'free_plan_without_ready_server', id: 'x1', customerId: customerA, detail: 'd' }], { customers });
assert(calm.needsAction === false && calm.subject.startsWith('Check:') && calm.subject.includes('usually clears itself'), 'a self-healing problem is not shouted about');
assert(calm.text.includes('usually clears by itself'), 'and says so');
const mixed = guidance.buildAlert([{ kind: 'free_plan_without_ready_server', id: 'x1', customerId: customerA, detail: 'd' }, findings[0]], { customers });
assert(mixed.text.indexOf('Jellyfin account with no paid plan') < mixed.text.indexOf('Free plan waiting for a server'), 'what needs action comes first');
assert(mixed.subject.startsWith('Needs attention:') && mixed.subject.includes('(+1 more)'));

// 4. Unknown customers and unknown kinds degrade safely, still without raw ids.
const noNames = guidance.buildAlert([findings[0]], { customers: new Map(), baseUrl: '' });
assert(noNames.text.includes('customer 11111111…') && !noNames.text.includes(customerA), 'a customer that cannot be looked up is shown by a short id only');
const unknown = guidance.buildAlert([{ kind: 'brand_new_check', id: accountId, customerId: null, detail: `Something about ${accountId} and ${entitlementId}` }], { customers });
assert(unknown.text.includes('Brand new check') && unknown.text.includes('45825a49…') && !unknown.text.includes(accountId), 'an unknown kind is humanised and its ids are shortened');

// 5. Many findings are summarised, not dumped.
const many = guidance.buildAlert(Array.from({ length: 12 }, (_, i) => ({ kind: 'primary_server_without_plan', id: `id${i}`, customerId: customerA, detail: 'd' })), { customers });
assert(many.text.includes('(12)') && many.text.includes('+7 more'), 'one kind with many customers shows the first five and a count');
const manyKinds = guidance.buildAlert(Object.keys(guidance.GUIDANCE).map((kind, i) => ({ kind, id: `i${i}`, customerId: null, detail: 'd' })), { customers });
assert(manyKinds.text.includes('more kind(s) of problem') && manyKinds.text.length <= 3800, 'many kinds are capped and still fit');

// 6. Customer-controlled text cannot break lines or ping everyone.
const hostile = guidance.buildAlert([findings[0]], { customers: new Map([[customerA, { display_name: 'Evil\n@everyone\r\nhi', email: '@here@example.com' }]]), baseUrl: '' });
assert(!/@everyone|@here/.test(hostile.text.replace(/@​everyone|@​here/g, '')), 'mentions are neutralised');
assert(!/Evil\n/.test(hostile.text), 'a name cannot add lines');

// 7. The job-log warning is readable too.
const warning = guidance.warningLine(findings);
assert(warning.includes('Jellyfin account with no paid plan') && !warning.includes(accountId) && warning.startsWith('2 customer/revenue integrity issues:'), 'the warning names the problems, not ids');

// 8. The shared wording is what the alert sender and the Automation page use.
assert(read('src/automation/revenue-integrity.js').includes('integrityGuidance.buildAlert('), 'the alert uses the shared builder');
assert(read('src/automation/jobs.js').includes('integrityGuidance.warningLine('), 'the job warning uses it');
assert(read('src/platform/admin-automation.js').includes("integrityGuidance.guidanceFor(finding.kind)") && !read('src/platform/admin-automation.js').includes('INTEGRITY_GUIDANCE['), 'the Automation page uses it');

console.log('integrity alert text smoke: ok');

// 3. Revenue finding with no single customer keeps the provider reference and links every affected customer; text fits one chat message.
{
    const dupA = '11111111-2222-4333-8444-555555555555', dupB = '66666666-7777-4888-8999-000000000000';
    const dup = { kind: 'duplicate_provider_billing_identity', id: 'abc12345-0000-4000-8000-000000000000', customerId: null, customerIds: [dupA, dupB],
        detail: `stripe provider identity sub_1TestIdentity999 is attached to 2 local subscriptions across customer(s) ${dupA}, ${dupB}.` };
    const alert = guidance.buildAlert([dup], { customers: new Map([[dupA, { display_name: 'Jane Smith', email: 'j@example.com' }]]), baseUrl: 'https://example.test' });
    for (const expected of ['sub_1TestIdentity999', 'Jane Smith', `https://example.test/admin/users/${dupA}`, 'customer 66666666…']) assert(alert.text.includes(expected), `duplicate identity alert should include ${expected}`);
    assert(!alert.text.includes('see Admin → Automation'), 'no pointer to a page that does not list revenue findings');
}
{
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'primary_server_without_plan' : 'invalid_recurring_provider_reference', id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        customerId: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`, detail: 'x'.repeat(300) }));
    const alert = guidance.buildAlert(many, { baseUrl: 'https://example.test' });
    assert(alert.text.length <= 1700, `alert text must fit Discord/Telegram (${alert.text.length})`);
    assert(!/https:\/\/example\.test\/admin\/users\/[^\s]{0,20}$/.test(alert.text), 'no half-cut link at the end');
}

// 4. An explicit admin link survives dispatch when there is no notification customer (it used to be overwritten with '').
(async () => {
    const payload = await require('../src/integrations/notification-dispatch').structuredPayload({ templatePayload: { adminUrl: 'https://example.test/admin/users/abc' } });
    assert.strictEqual(payload.adminUrl, 'https://example.test/admin/users/abc');
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
