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
assert(withLink.includes('value="https://store.example/activate/RAWTOKEN123"') && withLink.includes('data-copy-value="https://store.example/activate/RAWTOKEN123"'), 'the full link is shown and copyable');
assert(withLink.includes('Copy link') && withLink.includes('valid until') && withLink.includes('href="/activate/RAWTOKEN123"'));
assert(withLink.includes('New onboarding link') && !withLink.includes('Reset / onboarding link'));

const without = compact.portalCard(detail, 'csrf', null);
assert(without.includes('Create onboarding link') && !without.includes('Onboarding link</span>') && !without.includes('data-copy-value'));

// Hostile token characters are escaped.
const hostile = compact.portalCard(detail, 'csrf', { url: 'https://x/"><script>alert(1)</script>', path: '/activate/"><b>', expiresAt: null });
assert(!hostile.includes('<script>alert(1)</script>') && !hostile.includes('"><b>'));

// A site with no public base URL still gives a usable relative link.
assert(compact.portalCard(detail, 'csrf', { url: null, path: '/activate/T', expiresAt: null }).includes('value="/activate/T"'));

// The route sends the operator to the card with the link.
const route = fs.readFileSync(path.join(__dirname, '..', 'src/platform/admin-customer-management.js'), 'utf8');
assert(route.includes("copy it from the Customer portal card") && route.includes("'#customer-portal'"));
console.log('customer onboarding link smoke: ok');
