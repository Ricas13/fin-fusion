'use strict';

const assert = require('assert');
const {
    renderStorefront,
    planCard,
    savingForPlan,
    monthlyEquivalent,
    bestValueCode,
    publicResellerTiers
} = require('../src/platform/storefront');

const plans = [
    {
        id: 'free', code: 'free-access', name: 'Free Access', description: 'Permanent free access when capacity is available.',
        service_type:'jellyfin',is_free_tier:true,billing_interval:'month',duration_days:30,price_minor:0,currency:'USD',streams:1,
        allow_downloads:false,allow_video_transcoding:false,capacity:{limit:0,used:0,remaining:0,soldOut:true}
    },
    {
        id: 'trial', code: 'trial-24h', name: '24-hour Trial', description: 'Try it free for 24 hours.',
        service_type:'jellyfin',billing_interval: 'trial', duration_days: 1, price_minor: 0, currency: 'USD', streams: 1,
        allow_downloads: false, allow_video_transcoding: false,capacity:{limit:10,used:10,remaining:0,soldOut:true}
    },
    {
        id: 'monthly', code: 'monthly', name: 'Monthly', description: 'Monthly access.',
        service_type:'jellyfin',billing_interval: 'month', duration_days: 30, price_minor: 600, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,marketing_features:['Three streams','Downloads included'],capacity:{limit:40,used:12,remaining:28,soldOut:false}
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

assert.strictEqual(savingForPlan(plans[3], plans), 600, '6-month plan should save $6 versus monthly');
assert.strictEqual(savingForPlan(plans[4], plans), 2200, 'yearly plan should save $22 versus monthly');
assert.strictEqual(monthlyEquivalent(plans[3]), 500, '6-month plan should work out to $5/month');
assert.strictEqual(bestValueCode(plans), 'yearly', 'yearly should remain the calculated best-value plan');

const closedCard = planCard(plans[4], { logged:false,registrationOpen:false });
assert.match(closedCard, /19 of 20 spots available/);
assert.match(closedCard, /Sign in to choose/);
assert.match(closedCard, /\/account\/login\?next=%2Faccount%23plans/);
assert.doesNotMatch(closedCard, /Best value|Save \$/);

const customMarketingCard = planCard(plans[2], { logged:false,registrationOpen:true });
assert.match(customMarketingCard, /Three streams/);
assert.match(customMarketingCard, /Downloads included/);
assert.doesNotMatch(customMarketingCard, /Direct-play focused/);

const soldTrial = planCard(plans[1], { logged:false,registrationOpen:true });
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

const closedReseller={id:'r1',code:'reseller-closed',name:'Reseller Closed',description:'Managed access.',seat_limit:50,streams:5,allow_video_transcoding:false,library_access_mode:'include',monthly_price_minor:1000,currency:'USD',active:true,visible:true,inventory:{limit:5,used:5,remaining:0,soldOut:true}};
const page = renderStorefront({ site: 'CAPTAiNFiN', plans, store, registrationOpen: false, logged: false,resellerTiers:[closedReseller],support:{supportEmail:'support@example.test'} });
for (const expected of [
    'heroSection','freeTierPanel','pricingGrid','finalCta','Your entertainment. One simple subscription.',
    'Free access','Still here — currently full.','Choose the access that fits you.','Stremio add-ons &amp; plans.',
    '0 spots available · Sold out','support@example.test'
]) assert.ok(page.includes(expected), `rendered storefront should include ${expected}`);
assert.ok(!page.includes('id="resellers"'), 'a fully closed reseller catalogue must not render publicly');
assert.ok(!page.includes('href="#resellers"'), 'a fully closed reseller catalogue must not add a nav link');
assert.ok(!page.includes('Reseller Closed'), 'closed reseller cards must not leak onto the homepage');
assert.strictEqual(publicResellerTiers([closedReseller]).length,0,'closed reseller tier must not be public');
assert.ok(page.indexOf('heroSection') < page.indexOf('id="free-access"'), 'hero should appear before free access');
assert.ok(page.indexOf('id="free-access"') < page.indexOf('id="plans"'), 'free access should appear above paid/trial plan cards');
assert.ok(page.indexOf('id="plans"') < page.indexOf('id="stremio"'), 'main plans should appear before Stremio');
for(const removed of ['featureGrid','experienceSection','stepsGrid','Everything you need to watch your way','From account to watching in minutes'])assert.ok(!page.includes(removed),`old marketing section should be gone: ${removed}`);

const openReseller={...closedReseller,id:'r2',code:'reseller-open',name:'Reseller Open',seat_limit:25,streams:3,inventory:{limit:10,used:4,remaining:6,soldOut:false}};
const mixedPage=renderStorefront({site:'CAPTAiNFiN',plans,store,registrationOpen:false,logged:false,resellerTiers:[closedReseller,openReseller],support:{supportEmail:'support@example.test'}});
assert.ok(mixedPage.includes('id="resellers"'),'an open reseller tier should render the reseller section');
assert.ok(mixedPage.includes('href="#resellers"'),'an open reseller tier should render the reseller nav link');
assert.ok(mixedPage.includes('Reseller Open'),'open reseller tier should be public');
assert.ok(mixedPage.includes('25 managed Jellyfin users'),'open reseller policy should render');
assert.ok(mixedPage.includes('3 concurrent streams per managed user'),'open reseller stream limit should render');
assert.ok(!mixedPage.includes('Reseller Closed'),'closed reseller tier should stay hidden even beside an open tier');
assert.strictEqual(publicResellerTiers([closedReseller,openReseller]).length,1,'only open reseller tiers should be public');

const openPlans=plans.map(plan=>plan.is_free_tier?{...plan,capacity:{limit:20,used:3,remaining:17,soldOut:false}}:plan);
const openPage = renderStorefront({ site: 'CAPTAiNFiN', plans:openPlans, store, registrationOpen: true, logged: false,resellerTiers:[] });
assert.ok(openPage.includes('Create account'));
assert.ok(openPage.includes('Free places are available now.'));
assert.ok(openPage.includes('Claim free access'));
assert.ok(openPage.includes('href="/account/register"'));
assert.ok(!openPage.includes('New customers can currently join by invitation.'));

const empty = renderStorefront({ site: 'Blank Install', plans: [], store: { copy: {}, features: [] }, registrationOpen: false, logged: false,resellerTiers:[] });
assert.ok(empty.includes('Blank Install'));
assert.ok(empty.includes('Everything stays in your account.'));
assert.ok(!empty.includes('NaN'));

console.log('storefront v2 smoke: ok');
