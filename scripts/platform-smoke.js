'use strict';

require('dotenv').config();
process.env.REQUIRE_EMAIL_VERIFICATION = 'false';

const fs = require('fs');
const customers = require('../src/customers');
const lifecycle = require('../src/payments/lifecycle');
const runtimeSettings = require('../src/platform/runtime-settings');
const { getPool, query } = require('../src/db');

function assertPasswordPolicySurfaces() {
    const register = fs.readFileSync('views/customer/register.ejs', 'utf8');
    const reset = fs.readFileSync('views/customer/reset-password.ejs', 'utf8');
    const security = fs.readFileSync('src/platform/customer-security.js', 'utf8');
    if (!register.includes('name="password" minlength="8"')) throw new Error('Registration form does not expose the 8-character portal password minimum');
    if ((reset.match(/minlength="8"/g) || []).length < 2) throw new Error('Password-reset form does not expose the 8-character portal password minimum');
    if ((security.match(/minlength=\\"8\\"/g) || []).length < 2) throw new Error('Account-security form does not expose the 8-character portal password minimum');
}

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
    const password = `S${suffix.slice(-6)}!`;
    if (password.length !== 8) throw new Error('Password smoke fixture must remain exactly 8 characters');
    assertPasswordPolicySurfaces();
    let shortRejected = false;
    try {
        await customers.validateNewPassword('Ab1!xy7');
    } catch (error) {
        shortRejected = String(error.message || '').includes('between 8 and 200 characters');
    }
    if (!shortRejected) throw new Error('Seven-character customer password was not rejected by the canonical policy');
    await customers.validateNewPassword(password);

    // Clean installs intentionally start with registration disabled and zero plans.
    // The smoke test configures only the fixtures it needs instead of relying on
    // product/business seeds.
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES('platform','{"publicRegistration":true,"requireEmailVerification":false,"storefrontEnabled":false}'::jsonb)
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=platform_settings.setting_value || EXCLUDED.setting_value,updated_at=NOW()
    `);
    await runtimeSettings.reload();

    const directCode = `smoke-direct-${suffix}`;
    const trialCode = `smoke-trial-${suffix}`;
    await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,sort_order)
        VALUES
          ($1,'Smoke direct plan','direct','month',30,600,'USD',3,'premium',TRUE,TRUE,10),
          ($2,'Smoke trial plan','direct','trial',1,0,'USD',1,'premium',TRUE,TRUE,20)
    `, [directCode, trialCode]);

    const registered = await customers.registerCustomer({
        email: `smoke-${suffix}@example.invalid`,
        username: `smoke_${suffix}`,
        password
    });
    if (!registered.customer?.id) throw new Error('Customer registration failed');

    const login = await customers.authenticateCustomer(`smoke-${suffix}@example.invalid`, password);
    if (!login || login.customerId !== registered.customer.id) throw new Error('Customer authentication failed');

    const plans = await customers.listPublicPlans();
    if (!plans.some(plan => plan.code === directCode) || !plans.some(plan => plan.code === trialCode)) {
        throw new Error('Explicit public plan fixtures are missing');
    }

    const portal = await customers.getCustomerPortal(registered.customer.id);
    if (!portal || portal.customer.id !== registered.customer.id) throw new Error('Customer portal query failed');
    if (portal.referralsEnabled) throw new Error('Fresh-install referral module unexpectedly enabled itself');
    if (portal.referralCode) throw new Error('Disabled referral module should not mint customer referral codes');

    if (lifecycle.mapProviderStatus('stripe', 'active') !== 'active') throw new Error('Stripe state mapping failed');
    if (lifecycle.mapProviderStatus('paypal', 'SUSPENDED') !== 'paused') throw new Error('PayPal state mapping failed');
    await verifyPaymentEventClaims(suffix);

    console.log(`Platform smoke test passed for ${login.username}; explicit plan fixtures=${plans.length}.`);
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
