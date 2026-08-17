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
        service_type:'jellyfin',billing_interval: 'trial', duration_days: 1, price_minor: 0, currency: 'USD', streams: 1,
        allow_downloads: false, allow_video_transcoding: false,capacity:{limit:10,used:10,remaining:0,soldOut:true}
    },
    {
        id: 'monthly', code: 'monthly', name: 'Monthly', description: 'Monthly access.',
        service_type:'jellyfin',billing_interval: 'month', duration_days: 30, price_minor: 600, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,capacity:{limit:40,used:12,remaining:28,soldOut:false}
    },
    {
        id: 'six', code: 'six-month', name: '6 Months', description: 'Six months access.',
        service_type:'jellyfin',billing_interval: '6_months', duration_days: 183, price_minor: 3000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,capacity:{limit:30,used:4,remaining:26,soldOut:false}
    },
    {
        id: 'year', code: 'yearly', name: 'Yearly', description: 'Yearly access.',
        service_type:'jellyfin',billing_interval: 'year', duration_days: 365, price_minor: 5000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,capacity:{limit:20,used:1,remaining:19,soldOut:false}
    },
    {
        id:'stremio',code:'stremio',name:'Stremio Add-on',description:'Stremio access.',service_type:'stremio',is_addon:true,
        billing_interval:'month',duration_days:30,price_minor:400,currency:'USD',streams:2,capacity:{limit:25,used:3,remaining:22,soldOut:false}
    }
];

// Legacy commercial math remains available to other callers even though the
// new storefront deliberately avoids the old “Best value / Save” marketing copy.
assert.strictEqual(savingForPlan(plans[2], plans), 600, '6-month plan should save $6 versus monthly');
assert.strictEqual(savingForPlan(plans[3], plans), 2200, 'yearly plan should save $22 versus monthly');
assert.strictEqual(monthlyEquivalent(plans[2]), 500, '6-month plan should work out to $5/month');
assert.strictEqual(bestValueCode(plans), 'yearly', 'yearly should remain the calculated best-value plan');

const closedCard = planCard(plans[3], { logged:false,registrationOpen:false });
assert.match(closedCard, /19 of 20 spots available/);
assert.match(closedCard, /Sign in to choose/);
assert.match(closedCard, /\/account\/login\?next=%2Faccount%23plans/);
assert.doesNotMatch(closedCard, /Best value|Save \$/);

const soldTrial = planCard(plans[0], { logged:false,registrationOpen:true });
assert.match(soldTrial, /0 spots available · Sold out/);
assert.match(soldTrial, /aria-disabled="true">Sold out/);
assert.doesNotMatch(soldTrial, /href="\/account\/register"/);

const store = {
    copy: {
        heroTitle: 'Your entertainment. One simple subscription.',
        heroSubtitle: 'Watch your way.',
        supportEmail: 'support@example.test'
    },
    features: ['Legacy feature data may remain stored but is no longer rendered.']
};

const resellerTiers=[{id:'r1',code:'reseller',name:'Reseller 50',description:'Managed access.',seat_limit:50,monthly_price_minor:1000,currency:'USD',inventory:{limit:5,used:5,remaining:0,soldOut:true}}];
const page = renderStorefront({ site: 'CAPTAiNFiN', plans, store, registrationOpen: false, logged: false,resellerTiers,support:{supportEmail:'support@example.test'} });
for (const expected of [
    'heroSection','pricingGrid','finalCta','Your entertainment. One simple subscription.',
    'Choose the access that fits you.','Stremio add-ons &amp; plans.','Reseller plans.','0 spots available · Sold out','support@example.test'
]) assert.ok(page.includes(expected), `rendered storefront should include ${expected}`);
assert.ok(page.indexOf('heroSection') < page.indexOf('id="plans"'), 'hero should appear before main plan inventory');
assert.ok(page.indexOf('id="plans"') < page.indexOf('id="stremio"'), 'main plans should appear before Stremio');
assert.ok(page.indexOf('id="stremio"') < page.indexOf('id="resellers"'), 'Stremio should appear before reseller plans');
for(const removed of ['featureGrid','experienceSection','stepsGrid','Everything you need to watch your way','From account to watching in minutes'])assert.ok(!page.includes(removed),`old marketing section should be gone: ${removed}`);

const openPage = renderStorefront({ site: 'CAPTAiNFiN', plans, store, registrationOpen: true, logged: false,resellerTiers:[] });
assert.ok(openPage.includes('Create account'));
assert.ok(openPage.includes('href="/account/register"'));
assert.ok(!openPage.includes('New customers can currently join by invitation.'));

const empty = renderStorefront({ site: 'Blank Install', plans: [], store: { copy: {}, features: [] }, registrationOpen: false, logged: false,resellerTiers:[] });
assert.ok(empty.includes('Blank Install'));
assert.ok(empty.includes('Everything stays in your account.'));
assert.ok(!empty.includes('NaN'));

console.log('storefront v2 smoke: ok');
