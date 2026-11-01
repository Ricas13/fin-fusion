'use strict';

// Real-database proof that the bounded "provider says active" expiry rule never takes away paid access from a customer who
// actually renewed, and only ends a term that is genuinely unpaid past the grace window. Also pins that pay-as-you-go (Plisio),
// manual grants and healthy subscriptions are untouched.
require('dotenv').config();
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'recurring-expiry-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique } = require('./test-fixture');
const expiry = require('../src/entitlements/subscription-expiry');

const created = { customers: [], plans: [], subs: [] };

async function plan(label) {
    const row = (await query(`
        INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order)
        VALUES($1,$2,'direct','jellyfin','month',30,1500,'GBP',2,TRUE,TRUE,999) RETURNING id
    `, [unique(`expiry-${label}`), `Expiry ${label}`])).rows[0];
    created.plans.push(row.id);
    return row.id;
}

function providerIdFor(source, label) {
    const token = unique(label).replace(/[^A-Za-z0-9]/g, '');
    if (source === 'stripe') return `sub_${token}`;
    if (source === 'paypal') return `I-${token.toUpperCase()}`;
    return `${source}-${token}`;
}

async function subscription({ label, source, billingMode, status = 'active', endOffset, providerId = true }) {
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`, [`Expiry ${label}`, `${unique(label)}@example.invalid`])).rows[0];
    created.customers.push(customer.id);
    const planId = await plan(label);
    const sub = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
        VALUES($1,$2,$3,$4,$5,NOW()-INTERVAL '40 days',NOW()+($6)::interval,$7,'jellyfin') RETURNING id
    `, [customer.id, planId, status, source, billingMode, endOffset, providerId ? providerIdFor(source, label) : null])).rows[0];
    created.subs.push(sub.id);
    return sub.id;
}

const statusOf = async id => (await query(`SELECT status FROM subscriptions WHERE id=$1`, [id])).rows[0].status;

async function cleanup() {
    await query(`DELETE FROM subscriptions WHERE id=ANY($1::uuid[])`, [created.subs]).catch(() => {});
    await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
    await query(`DELETE FROM plans WHERE id=ANY($1::uuid[])`, [created.plans]).catch(() => {});
}

runDbSmoke('recurring expiry live subscriptions DB smoke', async () => {
    try {
        // Customers who renewed or are healthy.
        const renewed = await subscription({ label: 'renewed', source: 'stripe', billingMode: 'subscription', endOffset: '-72 hours' });
        const renewedPaypal = await subscription({ label: 'renewed-paypal', source: 'paypal', billingMode: 'subscription', endOffset: '-72 hours' });
        const healthy = await subscription({ label: 'healthy', source: 'stripe', billingMode: 'subscription', endOffset: '10 days' });
        // Late, but inside the bounded grace.
        const lateInGrace = await subscription({ label: 'late-in-grace', source: 'stripe', billingMode: 'subscription', endOffset: '-10 hours' });
        // Provider still says active, nothing paid, long overdue.
        const unpaidActive = await subscription({ label: 'unpaid-active', source: 'stripe', billingMode: 'subscription', endOffset: '-72 hours' });
        // Provider unreachable.
        const outageShort = await subscription({ label: 'outage-short', source: 'stripe', billingMode: 'subscription', endOffset: '-10 hours' });
        const outageLong = await subscription({ label: 'outage-long', source: 'paypal', billingMode: 'subscription', endOffset: '-72 hours' });
        // Not Stripe/PayPal recurring: pay-as-you-go crypto, manual grant.
        const paygPaid = await subscription({ label: 'payg-paid', source: 'plisio', billingMode: 'payment', endOffset: '12 days' });
        const paygOver = await subscription({ label: 'payg-over', source: 'plisio', billingMode: 'payment', endOffset: '-3 days' });
        const manual = await subscription({ label: 'manual', source: 'admin_grant', billingMode: 'payment', endOffset: '20 days', providerId: false });

        const advanced = new Set([renewed, renewedPaypal]);
        const unreachable = new Set([outageShort, outageLong]);
        const recorded = [];
        const syncRecurring = async id => {
            if (unreachable.has(id)) return { ok: false, error: 'provider unreachable' };
            if (advanced.has(id)) {
                // What a real sync does after a successful renewal: adopt the provider's new paid-through date.
                await query(`UPDATE subscriptions SET current_period_end=NOW()+INTERVAL '20 days' WHERE id=$1`, [id]);
            }
            return { ok: true, remote: { status: 'active', cancelAtPeriodEnd: false } };
        };

        await expiry.expireDueSubscriptions({ syncRecurring, graceHours: 48, incidentRecorder: async (...args) => { recorded.push(args); return {}; } });

        assert.strictEqual(await statusOf(renewed), 'active', 'a Stripe customer who renewed (period end advanced by the sync) keeps access');
        assert.strictEqual(await statusOf(renewedPaypal), 'active', 'a PayPal customer who renewed keeps access');
        assert.strictEqual(await statusOf(healthy), 'active', 'a subscription paid through the future is untouched');
        assert.strictEqual(await statusOf(lateInGrace), 'active', 'a renewal that is merely a few hours late is protected');
        assert.strictEqual(await statusOf(outageShort), 'active', 'a brief provider outage never cuts off a paying customer');
        assert.strictEqual(await statusOf(paygPaid), 'active', 'pay-as-you-go access that is paid through is untouched');
        assert.strictEqual(await statusOf(manual), 'active', 'a manual grant is untouched');

        // Only genuinely unpaid terms end.
        assert.strictEqual(await statusOf(unpaidActive), 'expired', 'an "active" agreement that never advanced its paid-through date for 72h has not been paid');
        assert.strictEqual(await statusOf(outageLong), 'expired', 'an outage that outlasts the grace ends the term (unchanged behaviour) and records an incident');
        assert.strictEqual(recorded.length, 1, 'exactly one durable incident for the exhausted verification');
        assert.strictEqual(await statusOf(paygOver), 'expired', 'a pay-as-you-go term that ran out ends as before');
    } finally {
        await cleanup();
    }
});
