'use strict';

const assert = require('assert');

process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || '11'.repeat(32);

const { query } = require('../src/db');
const providerSettings = require('../src/payments/provider-settings');
const lifecycle = require('../src/payments/lifecycle');
const customerFilters = require('../src/platform/customer-filters');

async function main() {
    const admin = await query(`INSERT INTO app_users(username,password_hash,role) VALUES('commerce-admin','x','admin') RETURNING id`);
    const adminId = admin.rows[0].id;

    await providerSettings.save('stripe', {
        enabled: true,
        restrictedKey: 'rk_test_browser_secret',
        webhookSecret: 'whsec_browser_secret'
    }, adminId);
    await providerSettings.save('paypal', {
        enabled: true,
        environment: 'sandbox',
        clientId: 'paypal-browser-client',
        clientSecret: 'paypal-browser-secret',
        webhookId: 'WH-BROWSER'
    }, adminId);

    let [stripeStatus, paypalStatus] = await Promise.all([
        providerSettings.status('stripe'), providerSettings.status('paypal')
    ]);
    assert.equal(stripeStatus.source, 'database');
    assert.equal(stripeStatus.enabled, true);
    assert.equal(stripeStatus.credentialsConfigured, true);
    assert.equal(stripeStatus.configured, true);
    assert.equal(stripeStatus.webhookConfigured, true);
    assert.equal(paypalStatus.source, 'database');
    assert.equal(paypalStatus.enabled, true);
    assert.equal(paypalStatus.credentialsConfigured, true);
    assert.equal(paypalStatus.configured, true);
    assert.equal(paypalStatus.webhookConfigured, true);
    assert.equal(paypalStatus.environment, 'sandbox');

    const encrypted = await query(`SELECT provider,secrets_encrypted FROM payment_provider_credentials ORDER BY provider`);
    assert.equal(encrypted.rowCount, 2);
    for (const row of encrypted.rows) {
        assert.ok(row.secrets_encrypted.startsWith('v1:'));
        assert.ok(!row.secrets_encrypted.includes('browser-secret'));
    }

    const realFetch = global.fetch;
    global.fetch = async url => {
        const href = String(url);
        if (href.startsWith('https://api.stripe.com/')) {
            return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (href.includes('paypal.com/v1/oauth2/token')) {
            return new Response(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected fetch in smoke test: ${href}`);
    };
    try {
        assert.equal((await providerSettings.testConnection('stripe')).ok, true);
        assert.equal((await providerSettings.testConnection('paypal')).ok, true);
    } finally {
        global.fetch = realFetch;
    }

    await providerSettings.save('stripe', { enabled: false }, adminId);
    stripeStatus = await providerSettings.status('stripe');
    assert.equal(stripeStatus.enabled, false);
    assert.equal(stripeStatus.credentialsConfigured, true);
    assert.equal(stripeStatus.configured, false);
    assert.equal(providerSettings.peek('stripe').restrictedKey, '');
    await providerSettings.save('stripe', { enabled: true }, adminId);
    stripeStatus = await providerSettings.status('stripe');
    assert.equal(stripeStatus.configured, true);

    const plan = await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES('flex-month','Flexible Monthly','direct','month',30,600,'USD',3,'premium',TRUE,TRUE)
        RETURNING id
    `);
    const planId = plan.rows[0].id;

    await query(`INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active) VALUES
        ($1,'stripe','price_once','payment',TRUE),
        ($1,'stripe','price_recurring','subscription',TRUE),
        ($1,'paypal',NULL,'payment',TRUE),
        ($1,'paypal','P-RECURRING','subscription',TRUE)`, [planId]);

    // Fleet capacity fails closed for any jellyfin premium/free plan with no
    // matching, enabled jellyfin_servers row (see plan-capacity.js's
    // fleetPlan gate), and getProviderOptions/getProviderPlan below check
    // that capacity -- so these servers must exist before those calls, not
    // just before the later customer-filters assertions.
    const serverA = await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,max_users,health_status) VALUES('Premium A','premium-a','premium','https://a.invalid','x',TRUE,1000,'healthy') RETURNING id`);
    const serverB = await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,max_users,health_status) VALUES('Premium B','premium-b','premium','https://b.invalid','x',TRUE,1000,'healthy') RETURNING id`);

    const stripeOptions = await lifecycle.getProviderOptions('flex-month', 'stripe');
    assert.deepEqual(stripeOptions.map(x => x.checkout_mode), ['payment', 'subscription']);
    assert.equal((await lifecycle.getProviderPlan('flex-month','stripe','payment')).external_id, 'price_once');
    assert.equal((await lifecycle.getProviderPlan('flex-month','stripe','subscription')).external_id, 'price_recurring');
    const paypalOptions = await lifecycle.getProviderOptions('flex-month', 'paypal');
    assert.equal(paypalOptions.length, 2);
    assert.equal((await lifecycle.getProviderPlan('flex-month','paypal','payment')).external_id, null);
    const customer = await query(`INSERT INTO customers(display_name,email) VALUES('Server User','server@example.test') RETURNING id`);
    const customerId = customer.rows[0].id;
    await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary) VALUES
        ($1,$2,'jf-a','ServerUser',FALSE,TRUE),
        ($1,$3,'jf-b','ServerUser',FALSE,FALSE)`, [customerId, serverA.rows[0].id, serverB.rows[0].id]);

    const list = await customerFilters.listCustomers({}, null, { page: 1, pageSize: 25 });
    const row = list.rows.find(x => x.id === customerId);
    assert.ok(row);
    assert.equal(row.account_count, 2);
    assert.equal(row.server_names, 'Premium A, Premium B');

    console.log('browser payments + flexible checkout smoke: ok');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error);
    process.exit(1);
});
