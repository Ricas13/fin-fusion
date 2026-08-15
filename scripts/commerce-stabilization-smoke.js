'use strict';

const express = require('express');
const { query, getPool } = require('../src/db');
const lifecycle = require('../src/payments/lifecycle');
const storefront = require('../src/platform/storefront');
const resellerStorefront = require('../src/platform/reseller-storefront');
const monthlyPortal = require('../src/platform/reseller-monthly-portal');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const CODES = {
    directPaid: 'smoke-stabilize-direct-paid',
    resellerPaid: 'smoke-stabilize-reseller-paid',
    directFree: 'smoke-stabilize-direct-free',
    resellerFree: 'smoke-stabilize-reseller-free'
};

async function cleanup() {
    await query("DELETE FROM subscriptions WHERE customer_id IN (SELECT id FROM customers WHERE display_name='Commerce Stabilization Smoke')");
    await query("DELETE FROM customers WHERE display_name='Commerce Stabilization Smoke'");
    await query('DELETE FROM plan_provider_prices WHERE plan_id IN (SELECT id FROM plans WHERE code=ANY($1::text[]))', [Object.values(CODES)]);
    await query('DELETE FROM plans WHERE code=ANY($1::text[])', [Object.values(CODES)]);
}

function routeCount(router, path, method) {
    let count = 0;
    const visit = stack => {
        for (const layer of stack || []) {
            if (layer.route && layer.route.path === path && layer.route.methods?.[method]) count += 1;
            if (layer.handle?.stack) visit(layer.handle.stack);
        }
    };
    visit(router?._router?.stack || router?.stack || []);
    return count;
}

async function main() {
    await cleanup();
    try {
        // staff-auth-preload suppresses the legacy app's GET /reseller declaration.
        // Requiring it here reproduces the same Express registration interception
        // used by npm start without starting an HTTP listener.
        require('../staff-auth-preload');
        const app = express();
        app.get('/reseller', (_req, res) => res.send('legacy reseller dashboard'));
        assert(routeCount(app, '/reseller', 'get') === 0, 'Legacy GET /reseller was still registered');
        app.use(monthlyPortal.createResellerMonthlyPortalRouter());
        assert(routeCount(app, '/reseller', 'get') === 1, 'Monthly reseller portal is not the sole GET /reseller handler');

        const compatibilityRouter = resellerStorefront.createResellerStorefrontRouter();
        assert(routeCount(compatibilityRouter, '/', 'get') === 0, 'Reseller storefront still registers a competing GET / route');

        const html = storefront.renderStorefront({
            site: 'CAPTaINFiN Smoke',
            plans: [],
            store: { copy: { supportEmail: 'support@example.com' }, features: [] },
            registrationOpen: false,
            logged: false,
            resellerTiers: [{
                name: 'Smoke Reseller',
                description: 'Canonical storefront tier',
                monthly_price_minor: 2500,
                currency: 'GBP',
                seat_limit: 5
            }]
        });
        assert(html.includes('id="resellers"'), 'Canonical storefront did not render the reseller section');
        assert(html.includes('href="#resellers"'), 'Canonical storefront did not render reseller navigation');
        assert(html.includes('Smoke Reseller'), 'Canonical storefront did not render reseller tier data');

        const directPaid = (await query(`
            INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
            VALUES($1,'Smoke Direct Paid','direct','month',30,600,'GBP',3,'premium',TRUE,TRUE)
            RETURNING *
        `, [CODES.directPaid])).rows[0];
        const resellerPaid = (await query(`
            INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
            VALUES($1,'Smoke Reseller Paid','reseller','month',30,600,'GBP',3,'premium',TRUE,TRUE)
            RETURNING *
        `, [CODES.resellerPaid])).rows[0];
        const directFree = (await query(`
            INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
            VALUES($1,'Smoke Direct Free','direct','month',30,0,'GBP',1,'free',TRUE,TRUE)
            RETURNING *
        `, [CODES.directFree])).rows[0];
        const resellerFree = (await query(`
            INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
            VALUES($1,'Smoke Reseller Free','reseller','month',30,0,'GBP',1,'free',TRUE,TRUE)
            RETURNING *
        `, [CODES.resellerFree])).rows[0];

        await query(`INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode) VALUES($1,'stripe','price_smoke_direct_stabilize','subscription')`, [directPaid.id]);
        await query(`INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode) VALUES($1,'stripe','price_smoke_reseller_stabilize','subscription')`, [resellerPaid.id]);

        const directOptions = await lifecycle.getProviderOptions(CODES.directPaid, 'stripe');
        const resellerOptions = await lifecycle.getProviderOptions(CODES.resellerPaid, 'stripe');
        assert(directOptions.length === 1, 'Direct customer provider mapping unexpectedly disappeared');
        assert(resellerOptions.length === 0, 'Customer checkout exposed a reseller-only provider mapping');
        assert(await lifecycle.getProviderPlan(CODES.resellerPaid, 'stripe') === null, 'getProviderPlan exposed a reseller-only plan');
        assert(await lifecycle.getProviderPlanByExternalId('stripe', 'price_smoke_reseller_stabilize') === null, 'Provider callback lookup exposed a reseller-only plan');

        const customer = (await query(`INSERT INTO customers(display_name) VALUES('Commerce Stabilization Smoke') RETURNING *`)).rows[0];
        let freeBlocked = false;
        try {
            await lifecycle.claimFreePlan(customer.id, CODES.resellerFree);
        } catch (error) {
            freeBlocked = /not available/i.test(error.message);
        }
        assert(freeBlocked, 'A direct customer could claim a reseller-only free plan');

        let purchaseBlocked = false;
        try {
            await lifecycle.activatePurchase({
                customerId: customer.id,
                planId: resellerPaid.id,
                provider: 'stripe',
                providerSubscriptionId: 'sub_smoke_reseller_only',
                providerStatus: 'active'
            });
        } catch (error) {
            purchaseBlocked = /plan not found/i.test(error.message);
        }
        assert(purchaseBlocked, 'activatePurchase accepted a reseller-only plan for a direct customer');

        const freeInsert = await query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','free_claim',NOW(),NOW()+INTERVAL '30 days')
            RETURNING source
        `, [customer.id, directFree.id]);
        assert(freeInsert.rows[0]?.source === 'free_claim', 'Database rejected the explicit free_claim subscription source');

        console.log('commerce stabilization smoke: ok');
    } finally {
        await cleanup();
        await getPool().end();
    }
}

main().catch(async error => {
    console.error(error);
    try { await cleanup(); } catch (_) {}
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
