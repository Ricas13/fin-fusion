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
        id: 'free', code: 'free-access', name: 'Free Access', description: 'Permanent free access when capacity is available.',
        service_type:'jellyfin',is_free_tier:true,billing_interval:'month',duration_days:30,price_minor:0,currency:'USD',streams:1,
        allow_downloads:false,allow_video_transcoding:false,capacity:{limit:0,used:0,remaining:0,soldOut:true,label:'Currently full',kind:'sold'}
    },
    {
        id: 'trial', code: 'trial-24h', name: '24-hour Trial', description: 'Try it free for 24 hours.',
        service_type:'jellyfin',billing_interval: 'trial', duration_days: 1, price_minor: 0, currency: 'USD', streams: 1,
        allow_downloads: false, allow_video_transcoding: false,capacity:{limit:10,used:10,remaining:0,soldOut:true,label:'Currently full',kind:'sold'}
    },
    {
        id: 'monthly', code: 'monthly', name: 'Monthly', description: 'Monthly access.',
        service_type:'jellyfin',billing_interval: 'month', duration_days: 30, price_minor: 600, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,marketing_features:['Three streams','Downloads included'],capacity:{limit:40,used:12,remaining:28,soldOut:false,label:'Available',kind:'available'}
    },
    {
        id: 'six', code: 'six-month', name: '6 Months', description: 'Six months access.',
        service_type:'jellyfin',billing_interval: '6_months', duration_days: 183, price_minor: 3000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,capacity:{limit:30,used:4,remaining:26,soldOut:false,label:'Available',kind:'available'}
    },
    {
        id: 'year', code: 'yearly', name: 'Yearly', description: 'Yearly access.',
        service_type:'jellyfin',billing_interval: 'year', duration_days: 365, price_minor: 5000, currency: 'USD', streams: 3,
        allow_downloads: true, allow_video_transcoding: false,capacity:{limit:20,used:1,remaining:19,soldOut:false,label:'Available',kind:'available'}
    },
    {
        id:'stremio',code:'stremio',name:'Stremio Plan',description:'Stremio access.',service_type:'stremio',is_addon:false,
        billing_interval:'month',duration_days:30,price_minor:400,currency:'USD',streams:2,capacity:{limit:25,used:3,remaining:22,soldOut:false,label:'Available',kind:'available'}
    }
];

assert.strictEqual(savingForPlan(plans[3], plans), 600, '6-month plan should save $6 versus monthly');
assert.strictEqual(savingForPlan(plans[4], plans), 2200, 'yearly plan should save $22 versus monthly');
assert.strictEqual(monthlyEquivalent(plans[3]), 500, '6-month plan should work out to $5/month');
assert.strictEqual(bestValueCode(plans), 'yearly', 'yearly should remain the calculated best-value plan');

const openCard = planCard(plans[4], { logged:false,registrationOpen:false });
assert.match(openCard, /planAvailability available">Available/);
assert.match(openCard, /Sign in to choose/);
assert.match(openCard, /\/account\/login\?next=%2Faccount%23plans/);
assert.doesNotMatch(openCard, /Best value|Save \$/);

const scarcePlan={...plans[4],capacity:{limit:20,used:18,remaining:2,soldOut:false,label:'🔥 Only 2 Premium places left',kind:'urgent'}};
const scarceCard=planCard(scarcePlan,{logged:false,registrationOpen:true});
assert.match(scarceCard,/🔥 Only 2 Premium places left/);
assert.match(scarceCard,/planAvailability urgent/);

const customMarketingCard = planCard(plans[2], { logged:false,registrationOpen:true });
assert.match(customMarketingCard, /Three streams/);
assert.match(customMarketingCard, /Downloads included/);
assert.doesNotMatch(customMarketingCard, /Direct-play focused/);

const soldTrial = planCard(plans[1], { logged:false,registrationOpen:true });
assert.match(soldTrial, /Currently full/);
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

const page = renderStorefront({ site: 'CAPTAiNFiN', plans, store, registrationOpen: false, logged: false,support:{supportEmail:'support@example.test'} });
for (const expected of [
    'heroSection','freeTierPanel','pricingGrid','finalCta','Your entertainment. One simple subscription.',
    'Free access','Still here — currently full.','Choose the Jellyfin server access that fits you.','Stremio plans',
    'Currently full','support@example.test'
]) assert.ok(page.includes(expected), `rendered storefront should include ${expected}`);
assert.ok(page.indexOf('heroSection') < page.indexOf('id="free-access"'), 'hero should appear before free access');
assert.ok(page.indexOf('id="free-access"') < page.indexOf('id="plans"'), 'free access should appear above paid/trial plan cards');
assert.ok(page.indexOf('id="plans"') < page.indexOf('id="stremio"'), 'main plans should appear before Stremio');
for(const removed of ['featureGrid','experienceSection','stepsGrid','Everything you need to watch your way','From account to watching in minutes'])assert.ok(!page.includes(removed),`old marketing section should be gone: ${removed}`);

const openPlans=plans.map(plan=>plan.is_free_tier?{...plan,capacity:{limit:20,used:3,remaining:17,soldOut:false,label:'Available',kind:'available'}}:plan);
const openPage = renderStorefront({ site: 'CAPTAiNFiN', plans:openPlans, store, registrationOpen: true, logged: false });
assert.ok(openPage.includes('Create account'));
assert.ok(openPage.includes('Free places are available now.'));
assert.ok(openPage.includes('Claim free access'));
assert.ok(openPage.includes('href="/account/register"'));
assert.ok(!openPage.includes('New customers can currently join by invitation.'));

const empty = renderStorefront({ site: 'Blank Install', plans: [], store: { copy: {}, features: [] }, registrationOpen: false, logged: false });
assert.ok(empty.includes('Blank Install'));
assert.ok(empty.includes('Everything stays in your account.'));
assert.ok(!empty.includes('NaN'));

console.log('storefront v2 smoke: ok');
