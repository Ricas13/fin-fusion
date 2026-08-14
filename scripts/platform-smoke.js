'use strict';

require('dotenv').config();
process.env.PUBLIC_REGISTRATION = 'true';
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';

const customers = require('../src/customers');
const lifecycle = require('../src/payments/lifecycle');
const { getPool, query } = require('../src/db');

async function verifyPaymentEventClaims(suffix) {
    const eventId = `smoke-concurrent-${suffix}`;
    const payload = { id: eventId, type: 'smoke.concurrent' };
    const claims = await Promise.all([
        lifecycle.beginPaymentEvent({ provider: 'stripe', eventId, eventType: payload.type, payload }),
        lifecycle.beginPaymentEvent({ provider: 'stripe', eventId, eventType: payload.type, payload })
    ]);
    const acquired = claims.filter(Boolean);
    if (acquired.length !== 1) throw new Error(`Concurrent payment event was claimed ${acquired.length} times`);
    if (!acquired[0].processing_token) throw new Error('Payment event claim did not return a processing token');
    if (!(await lifecycle.finishPaymentEvent(acquired[0]))) throw new Error('Payment event claim could not be completed');
    if (await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId, eventType: payload.type, payload })) {
        throw new Error('Processed payment event was claimable again');
    }

    const retryId = `smoke-retry-${suffix}`;
    const retryPayload = { id: retryId, type: 'smoke.retry' };
    const failedClaim = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId: retryId, eventType: retryPayload.type, payload: retryPayload });
    if (!failedClaim) throw new Error('Initial retry payment event claim failed');
    if (!(await lifecycle.finishPaymentEvent(failedClaim, new Error('intentional smoke failure')))) throw new Error('Failed payment event could not be released');
    const retryClaim = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId: retryId, eventType: retryPayload.type, payload: retryPayload });
    if (!retryClaim) throw new Error('Failed payment event was not immediately retryable');
    if (!(await lifecycle.finishPaymentEvent(retryClaim))) throw new Error('Retried payment event could not be completed');

    const staleId = `smoke-stale-${suffix}`;
    const stalePayload = { id: staleId, type: 'smoke.stale' };
    const staleClaim = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: staleId, eventType: stalePayload.type, payload: stalePayload });
    if (!staleClaim) throw new Error('Initial stale payment event claim failed');
    await query(`
        UPDATE payment_events
        SET processing_started_at=NOW() - (($2::int + 1) * INTERVAL '1 minute')
        WHERE id=$1
    `, [staleClaim.id, lifecycle.PAYMENT_EVENT_LEASE_MINUTES]);
    const reclaimed = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: staleId, eventType: stalePayload.type, payload: stalePayload });
    if (!reclaimed || reclaimed.processing_token === staleClaim.processing_token) throw new Error('Stale payment event lease was not safely reclaimed');
    if (await lifecycle.finishPaymentEvent(staleClaim)) throw new Error('Expired payment event claim was allowed to finish after reassignment');
    if (!(await lifecycle.finishPaymentEvent(reclaimed))) throw new Error('Reclaimed payment event could not be completed');
}

async function main() {
    const suffix = Date.now().toString(36);
    const password = `Smoke-Test-${suffix}-Password`;
    const registered = await customers.registerCustomer({
        email: `smoke-${suffix}@example.invalid`,
        username: `smoke_${suffix}`,
        password
    });
    if (!registered.customer?.id) throw new Error('Customer registration failed');

    const login = await customers.authenticateCustomer(`smoke-${suffix}@example.invalid`, password);
    if (!login || login.customerId !== registered.customer.id) throw new Error('Customer authentication failed');

    const plans = await customers.listPublicPlans();
    if (plans.length < 4) throw new Error('Seeded plans are missing');

    const seededCredits = await query(`
        SELECT code,reseller_credit_cost,reseller_trial_credit_cost
        FROM plans WHERE code IN ('trial-24h','monthly') ORDER BY code
    `);
    const monthly = seededCredits.rows.find(row => row.code === 'monthly');
    const trial = seededCredits.rows.find(row => row.code === 'trial-24h');
    if (Number(monthly?.reseller_credit_cost) !== 1) throw new Error('Seeded monthly reseller credit cost is missing');
    if (Number(trial?.reseller_trial_credit_cost) !== 1) throw new Error('Seeded trial credit cost is missing');

    const resellerCode = `smoke-reseller-${suffix}`;
    await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,reseller_credit_cost,reseller_trial_credit_cost)
        VALUES($1,'Smoke reseller plan','reseller','custom',45,0,'USD',2,'premium',TRUE,TRUE,3,2)
    `, [resellerCode]);
    const publicAfterReseller = await customers.listPublicPlans();
    if (publicAfterReseller.some(plan => plan.code === resellerCode)) throw new Error('Reseller-only plan leaked into public Store plans');

    const portal = await customers.getCustomerPortal(registered.customer.id);
    if (!portal || portal.customer.id !== registered.customer.id) throw new Error('Customer portal query failed');

    if (lifecycle.mapProviderStatus('stripe', 'active') !== 'active') throw new Error('Stripe state mapping failed');
    if (lifecycle.mapProviderStatus('paypal', 'SUSPENDED') !== 'paused') throw new Error('PayPal state mapping failed');
    await verifyPaymentEventClaims(suffix);

    console.log(`Platform smoke test passed for ${login.username}; ${plans.length} public plans available.`);
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
