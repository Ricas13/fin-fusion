'use strict';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

(async () => {
    const currentPlan = {
        id: 'plan-1', plan_id: 'plan-1', name: 'Monthly', code: 'monthly', status: 'active',
        source: 'invitation', current_period_end: new Date(Date.now() + 86400000), streams: 3,
        allow_downloads: true, allow_video_transcoding: false
    };
    const locals = {
        siteName: 'Test Streams',
        portal: {
            customer: { login_username: 'viewer1', display_name: 'Viewer One' },
            subscriptions: [{ plan_name: 'Monthly', status: 'active', current_period_end: currentPlan.current_period_end }],
            accounts: [{ id: 'account-1', jellyfin_username: 'viewer1', disabled: false, server_name: 'Primary', server_class: 'premium', public_url: 'https://jellyfin.example.test' }],
            providers: [],
            referralCode: 'ABC123',
            referralsEnabled: true
        },
        currentPlan,
        plans: [
            { id: 'plan-1', code: 'monthly', name: 'Monthly', billing_interval: 'month', duration_days: 30, price_minor: 600, currency: 'USD', description: 'Monthly access', streams: 3, allow_downloads: true, allow_video_transcoding: false, payment_options: [] },
            { id: 'plan-2', code: 'yearly', name: 'Yearly', billing_interval: 'year', duration_days: 365, price_minor: 5000, currency: 'USD', description: 'Yearly access', streams: 3, allow_downloads: true, allow_video_transcoding: false, payment_options: [] }
        ],
        stripeEnabled: false,
        paypalEnabled: false,
        overseerrUrl: null,
        libraryEntitlement: ['Movies', 'TV'],
        librarySelection: ['Movies'],
        csrfToken: 'csrf-test',
        message: null,
        error: null
    };

    const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'customer', 'dashboard.ejs'), locals);
    assert.match(html, /Welcome back, viewer1/);
    assert.match(html, /Your access/);
    assert.match(html, /Current plan/);
    assert.match(html, /Library visibility/);
    assert.match(html, /Plans/);
    assert.match(html, /Refer a friend/);
    assert.match(html, /customer-portal\.css/);
    assert(!html.includes('Invalid Date'), 'Portal must never render Invalid Date');
    assert.match(html, /Open Jellyfin/);
    assert.match(html, /Current/);

    const empty = await ejs.renderFile(path.join(__dirname, '..', 'views', 'customer', 'dashboard.ejs'), {
        ...locals,
        portal: { ...locals.portal, subscriptions: [], accounts: [], referralCode: null, referralsEnabled: false },
        currentPlan: null,
        plans: [],
        libraryEntitlement: [],
        librarySelection: []
    });
    assert.match(empty, /do not currently have an active subscription/i);
    assert.match(empty, /No plans are currently available/i);
    assert.doesNotMatch(empty, /Refer a friend/, 'Disabled referral module must not appear in the portal');

    console.log('customer portal view smoke: ok');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
