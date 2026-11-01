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
const db = require('../src/db');
const { runDbSmoke, unique } = require('./test-fixture');

// Populated only inside the smoke's uncommitted database transaction.
// The expiry module captures db.query/db.transaction at import time, so require it after binding these.
let query = null;

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

// This test calls a GLOBAL expiry sweep. Never run it against an ordinary database, even though every
// SQL write is enclosed in a rollback-only transaction. CI supplies a disposable local PostgreSQL service.
// Local runs require an explicit opt-in AND a local database whose name says test/ci/smoke.
function safeDatabaseUrl() {
    const raw = String(process.env.DATABASE_URL || '');
    let url;
    try { url = new URL(raw); } catch { throw new Error('Expiry DB smoke requires a valid disposable DATABASE_URL.'); }
    const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
        && process.env.GITHUB_REPOSITORY === 'Ricas13/fin-fusion'
        && url.pathname === '/steamfusion' && url.username === 'steamfusion';
    const optedIn = process.env.EXPIRY_DB_SMOKE_DISPOSABLE === 'I_ACCEPT_DISPOSABLE_DB'
        && /(?:^|[_-])(test|ci|smoke)(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)));
    assert(localHost && process.env.NODE_ENV === 'test' && (ci || optedIn),
        'Refusing global expiry smoke outside a local, explicitly disposable test database.');
    return { url, ci };
}

runDbSmoke('recurring expiry live subscriptions DB smoke', async () => {
    const { url, ci } = safeDatabaseUrl();
    const client = await db.getPool().connect();
    const originalQuery = db.query;
    const originalTransaction = db.transaction;
    let started = false;
    let snapshotBefore = null;
    try {
        const identity = (await client.query('SELECT current_database() AS name, current_user AS role')).rows[0];
        assert.strictEqual(identity.name, decodeURIComponent(url.pathname.slice(1)), 'Database identity must match the disposable URL');
        if (ci) assert.strictEqual(identity.role, 'steamfusion', 'CI must use its disposable database owner');
        // Snapshot every subscription BEFORE the transaction. Earlier suites in the same database leave overdue subscriptions
        // behind, and the global sweep may legitimately touch them INSIDE our transaction, so the guarantee we check is that
        // after the ROLLBACK nothing at all has changed.
        snapshotBefore = (await client.query('SELECT id,status,current_period_end,service_extension_days,updated_at FROM subscriptions ORDER BY id')).rows;
        await client.query('BEGIN');
        started = true;
        query = (sql, params) => client.query(sql, params);
        db.query = query;
        // The production expiry SQL runs unchanged on the SAME connection; its transaction wrapper is
        // replaced only to avoid committing inside our outer, deliberately rollback-only transaction.
        db.transaction = async fn => fn(client);
        const expiry = require('../src/entitlements/subscription-expiry');
        const billingControl = require('../src/payments/billing-control');
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
                // Exercise the REAL syncSubscription -> applyRemoteState -> updateProviderSubscription
                // chain, substituting only the remote provider's successful renewed-period response.
                return billingControl.syncSubscription(id, { adapter: {
                    fetchRemote: async () => ({
                        status: 'active',
                        periodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
                        cancelAtPeriodEnd: false
                    })
                } });
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
        assert.strictEqual(recorded.length, 1, 'incident recorder invoked once for exhausted verification');
        assert.strictEqual(recorded[0][0].kind, 'failed_renewal');
        assert.strictEqual(recorded[0][0].metadata.reason, 'expiry_provider_verification_exhausted');
        assert.strictEqual(await statusOf(paygOver), 'expired', 'a pay-as-you-go term that ran out ends as before');
    } finally {
        try {
            if (started) await client.query('ROLLBACK');
        } finally {
            db.query = originalQuery;
            db.transaction = originalTransaction;
            query = null;
            client.release();
        }
    }
    // Rollback, not best-effort DELETE, is the sole cleanup mechanism. Any failure here fails CI.
    const snapshotAfter = (await db.query('SELECT id,status,current_period_end,service_extension_days,updated_at FROM subscriptions ORDER BY id')).rows;
    assert.deepStrictEqual(snapshotAfter, snapshotBefore, 'the rollback-only smoke must leave EVERY subscription exactly as it found it');
    const survivors = await db.query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE id=ANY($1::uuid[])', [created.subs]);
    assert.strictEqual(survivors.rows[0].n, 0, 'the expiry smoke must leave zero fixture subscriptions behind');
});
