'use strict';

const assert = require('assert');
const {
    renderStorefront,
    planCard,
    savingForPlan,
    monthlyEquivalent,
    bestValueCode
} = require('../src/platform/storefront');

const plans = [
    {
        id: 'trial', code: 'trial-24h', name: '24-hour Trial', description: 'Try it free for 24 hours.',
        billing_interval: 'trial', duration_days: 1, price_minor: 0, currency: 'USD', streams: 1,
        allow_downloads: false, allow_video_transcoding: false
    },
    {
        id: 'monthly', code: 'monthly', name: 'Monthly', description: 'Monthly access.',
        billing_interval: 'month', duration_days: 30, price_minor: 600, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false
    },
    {
        id: 'six', code: 'six-month', name: '6 Months', description: 'Six months access.',
        billing_interval: '6_months', duration_days: 183, price_minor: 3000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false
    },
    {
        id: 'year', code: 'yearly', name: 'Yearly', description: 'Yearly access.',
        billing_interval: 'year', duration_days: 365, price_minor: 5000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false
    }
];

assert.strictEqual(savingForPlan(plans[2], plans), 600, '6-month plan should save $6 versus monthly');
assert.strictEqual(savingForPlan(plans[3], plans), 2200, 'yearly plan should save $22 versus monthly');
assert.strictEqual(monthlyEquivalent(plans[2]), 500, '6-month plan should work out to $5/month');
assert.strictEqual(bestValueCode(plans), 'yearly', 'yearly should be selected as best value');

const closedCard = planCard(plans[3], plans, { logged: false, registrationOpen: false }, 'yearly');
assert.match(closedCard, /Best value/);
assert.match(closedCard, /About \$4\.17 \/ month/);
assert.match(closedCard, /Sign in to choose/);
assert.match(closedCard, /\/account\/login\?next=%2Faccount%23plans/);
assert.doesNotMatch(closedCard, /Choose in account/);

const openTrial = planCard(plans[0], plans, { logged: false, registrationOpen: true }, 'yearly');
assert.match(openTrial, /Start free trial/);
assert.match(openTrial, /href="\/account\/register"/);

const store = {
    copy: {
        heroTitle: 'Your entertainment. One simple subscription.',
        heroSubtitle: 'Watch your way.',
        featureTitle: 'Everything you need',
        announcement: 'New films added every week',
        supportEmail: 'support@example.test'
    },
    features: ['Huge library', 'Three streams', 'Downloads', 'TV and mobile', 'Self-service', 'Requests']
};

const page = renderStorefront({ site: 'CAPTaINFiN', plans, store, registrationOpen: false, logged: false });
for (const expected of [
    'heroSection', 'heroVisual', 'featureGrid', 'experienceSection', 'pricingGrid', 'stepsGrid', 'finalCta',
    'Your entertainment. One simple subscription.', 'New films added every week', 'Best value', 'Save $6',
    'Plans from <strong>$4.17</strong> / month', 'support@example.test', 'New customers can currently join by invitation.'
]) assert.ok(page.includes(expected), `rendered storefront should include ${expected}`);
assert.ok(page.indexOf('heroSection') < page.indexOf('pricingGrid'), 'hero should appear before pricing');
assert.ok(!page.includes('Choose in account'), 'old prototype CTA should be gone');

const openPage = renderStorefront({ site: 'CAPTaINFiN', plans, store, registrationOpen: true, logged: false });
assert.ok(openPage.includes('Create your account'));
assert.ok(openPage.includes('href="/account/register"'));
assert.ok(!openPage.includes('New customers can currently join by invitation.'));

const empty = renderStorefront({ site: 'Blank Install', plans: [], store: { copy: {}, features: [] }, registrationOpen: false, logged: false });
assert.ok(empty.includes('No public plans are available yet.'));
assert.ok(empty.includes('Blank Install'));
assert.ok(!empty.includes('NaN'));

console.log('storefront v2 smoke: ok');
