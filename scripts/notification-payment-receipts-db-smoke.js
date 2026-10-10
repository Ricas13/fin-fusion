'use strict';

// Regression: one-time access extensions (the usual crypto renewal) and recurring PayPal
// renewals produced no "payment received" notification because the lifecycle scan only
// looked at first-purchase activation audit rows and Stripe invoices.

require('dotenv').config();
const assert = require('assert');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('Notification payment receipts DB smoke')) process.exit(0);

const { query } = require('../src/db');
const dispatch = require('../src/integrations/notification-dispatch');
const lifecycle = require('../src/automation/notification-lifecycle');
const { runDbSmoke, unique, fixtureCustomer, fixturePlan, fixtureSubscription } = require('./test-fixture');

async function main() {
    const original = dispatch.dispatch;
    const previousState = (await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [lifecycle.STATE_KEY])).rows[0]?.setting_value || null;
    const created = { customers: [], plans: [] };
    try {
        const customer = await fixtureCustomer({ query }, { displayName: 'Receipt Customer', email: `${unique('receipt')}@example.invalid` });
        created.customers.push(customer.id);
        const plan = await fixturePlan({ query }, { code: unique('receipt-plan'), name: 'Receipt Plan', serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 1000, currency: 'GBP', streams: 1, serverClass: 'premium' });
        created.plans.push(plan.id);

        const plisioSub = await fixtureSubscription({ query }, { customerId: customer.id, planId: plan.id, source: 'plisio', billingMode: 'payment', providerSubscriptionId: unique('plisio-txn'), currentPeriodEnd: new Date(Date.now() + 400 * 86400000).toISOString() });
        const paypalSub = await fixtureSubscription({ query }, { customerId: customer.id, planId: plan.id, source: 'paypal', billingMode: 'subscription', providerSubscriptionId: `I-receipt-${unique('paypal')}` });

        const start = new Date(Date.now() - 5 * 60 * 1000);
        await query(`
            INSERT INTO platform_settings(setting_key,setting_value)
            VALUES($1,$2::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
        `, [lifecycle.STATE_KEY, JSON.stringify({ cursor: start.toISOString(), servers: {} })]);

        const extensionAudit = (await query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('payment.access_extension.activate','subscription',$1,$2::jsonb) RETURNING id
        `, [plisioSub.id, JSON.stringify({ provider: 'plisio', providerSubscriptionId: plisioSub.provider_subscription_id })])).rows[0];
        await query(`
            INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at)
            VALUES('paypal',$1,'PAYMENT.SALE.COMPLETED',$2::jsonb,NOW())
        `, [unique('evt'), JSON.stringify({ resource: { billing_agreement_id: paypalSub.provider_subscription_id } })]);

        const seen = [];
        dispatch.dispatch = async input => { seen.push(input); return { email: false, telegram: false, discord: false, errors: [] }; };
        const first = await lifecycle.run();
        const receipts = seen.filter(input => input.eventType === 'payment.received' && String(input.customerId) === String(customer.id));
        assert.strictEqual(receipts.length, 2, `an extension and a PayPal renewal must each produce one receipt (got ${receipts.length}: ${JSON.stringify(receipts.map(r => r.dedupeKey))})`);
        const extension = receipts.find(input => input.dedupeKey === `payment-received:extension:${extensionAudit.id}`);
        assert(extension, 'the extension receipt must be keyed by its audit row');
        assert(/extension of Receipt Plan via plisio/.test(extension.text), extension.text);
        assert(/access now runs until \d{4}-\d{2}-\d{2}/.test(extension.text), 'the receipt must state the new access end date');
        assert(/Receipt Customer/.test(extension.adminText), 'admins must be told which customer paid');
        assert(receipts.some(input => /PayPal confirmed payment/.test(input.text)), 'the PayPal renewal must produce a receipt');
        assert.strictEqual(first.failed, 0);

        seen.length = 0;
        await lifecycle.run();
        assert.strictEqual(seen.filter(input => input.eventType === 'payment.received' && String(input.customerId) === String(customer.id)).length, 0,
            'a processed window must not notify the same payment again');
    } finally {
        dispatch.dispatch = original;
        if (previousState) {
            await query(`UPDATE platform_settings SET setting_value=$1::jsonb,updated_at=NOW() WHERE setting_key=$2`, [JSON.stringify(previousState), lifecycle.STATE_KEY]).catch(() => {});
        }
        await query(`DELETE FROM payment_events WHERE provider='paypal' AND payload->'resource'->>'billing_agreement_id' LIKE 'I-receipt-%'`).catch(() => {});
        if (created.customers.length) await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
        if (created.plans.length) await query(`DELETE FROM plans WHERE id=ANY($1::uuid[])`, [created.plans]).catch(() => {});
    }
}

runDbSmoke('Notification payment receipts DB smoke', main).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
