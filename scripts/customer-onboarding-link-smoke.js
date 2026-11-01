'use strict';

// The customer page shows the one-time onboarding link (copy/open) after "Create / New onboarding link", instead of only a message.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const compact = require('../src/platform/customer-360-compact');

const customer = { id: '11111111-2222-4333-8444-555555555555', app_user_id: 'u1', login_active: false, login_username: 'Hassan', login_email: 'h@example.com', email: 'h@example.com' };
const detail = { customer, subscriptions: [], activeHolds: [] };
const onboarding = { url: 'https://store.example/activate/RAWTOKEN123', path: '/activate/RAWTOKEN123', expiresAt: '2026-11-08T10:00:00Z' };

const withLink = compact.portalCard(detail, 'csrf', onboarding);
assert(withLink.includes('id="customer-portal"'), 'the card is an anchor target');
const linkAttribute = (html, name) => (html.match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
assert.strictEqual(linkAttribute(withLink, 'value'), onboarding.url, 'the full link is shown');
assert.strictEqual(linkAttribute(withLink, 'data-copy-value'), onboarding.url, 'and copyable');
assert(withLink.includes('Copy link') && withLink.includes('valid until') && withLink.includes('href="/activate/RAWTOKEN123"'));
assert(withLink.includes('New onboarding link') && !withLink.includes('Reset / onboarding link'));

const without = compact.portalCard(detail, 'csrf', null);
assert(without.includes('Create onboarding link') && !without.includes('Onboarding link</span>') && !without.includes('data-copy-value'));

// Hostile token characters are escaped.
const hostile = compact.portalCard(detail, 'csrf', { url: 'https://x/"><script>alert(1)</script>', path: '/activate/"><b>', expiresAt: null });
assert(!hostile.includes('<script>alert(1)</script>') && !hostile.includes('"><b>'));

// A site with no public base URL still gives a usable relative link.
assert(compact.portalCard(detail, 'csrf', { url: null, path: '/activate/T', expiresAt: null }).includes('value="/activate/T"'));

// Loader: HTTPS-only absolute links in production, isolation per customer, nothing when there is no portal user or no active token.
(async () => {
    const queries = [];
    const queryFn = async (sql, params) => { queries.push(params[0]); return { rows: params[0] === customer.id ? [{ user_id: 'u1' }] : [] }; };
    const seenUsers = [];
    const activeForUser = async userId => { seenUsers.push(userId); return userId === 'u1' ? { raw: 'RAW/TOKEN', expires_at: '2026-11-08T10:00:00Z' } : null; };
    const httpCfg = { publicBaseUrl: 'http://store.example' }, httpsCfg = { publicBaseUrl: 'https://store.example' };
    let link = await compact.onboardingLink(customer.id, { queryFn, activeForUser, settings: httpCfg, env: { NODE_ENV: 'production' } });
    assert.strictEqual(link.url, null, 'an http base URL never reaches the copyable absolute link in production');
    assert.strictEqual(link.path, '/activate/RAW%2FTOKEN');
    const rendered = compact.portalCard(detail, 'csrf', link);
    const attributeUrls = [...rendered.matchAll(/(?:value|data-copy-value|href)="([^"]*)"/g)].map(match => match[1]);
    assert(attributeUrls.some(value => value.startsWith('/activate/')) && !attributeUrls.some(value => /^https?:/i.test(value)), 'only the relative link is rendered when the base is not https');
    link = await compact.onboardingLink(customer.id, { queryFn, activeForUser, settings: httpsCfg, env: { NODE_ENV: 'production' } });
    assert.strictEqual(link.url, 'https://store.example/activate/RAW%2FTOKEN');
    link = await compact.onboardingLink(customer.id, { queryFn, activeForUser, settings: httpCfg, env: { NODE_ENV: 'development' } });
    assert.strictEqual(link.url, 'http://store.example/activate/RAW%2FTOKEN', 'outside production http is allowed, like the management page');
    for (const bad of ['', 'not a url', 'ftp://x/y', 'javascript:alert(1)']) assert.strictEqual(compact.secureActivationBase(bad, { NODE_ENV: 'production' }), '');
    assert.strictEqual(await compact.onboardingLink('other-customer', { queryFn, activeForUser, settings: httpsCfg }), null, 'a customer without a portal user gets nothing');
    assert.deepStrictEqual(seenUsers.filter(id => id !== 'u1'), [], 'only the selected customer\'s portal user is looked up');
    assert.strictEqual(await compact.onboardingLink(customer.id, { queryFn, activeForUser: async () => null, settings: httpsCfg }), null, 'no active token -> nothing shown');
    // The real token query only returns unused, unrevoked, unexpired activation tokens.
    const activationSource = fs.readFileSync(path.join(__dirname, '..', 'src/auth/account-activation.js'), 'utf8');
    assert(/used_at IS NULL AND revoked_at IS NULL AND expires_at>NOW\(\)/.test(activationSource));
    // The route sends the operator to the card with the link.
const route = fs.readFileSync(path.join(__dirname, '..', 'src/platform/admin-customer-management.js'), 'utf8');
assert(route.includes("copy it from the Customer portal card") && route.includes("'#customer-portal'"));
console.log('customer onboarding link smoke: ok');
})().catch(error => { console.error(error); process.exit(1); });
