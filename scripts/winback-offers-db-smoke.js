'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const winback = require('../src/marketing/winback-offers');
const failedRenewals = require('../src/payments/failed-renewals');

async function customer(name) {
    return (await query(`
        INSERT INTO customers(display_name,email,marketing_opt_in)
        VALUES($1,$2,TRUE) RETURNING id
    `, [name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`])).rows[0];
}

async function subscription({ customerId, planId, providerId }) {
    return (await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id
        ) VALUES($1,$2,'cancelled','stripe','subscription',NOW()-INTERVAL '31 days',NOW()-INTERVAL '1 day',$3)
        RETURNING id,updated_at
    `, [customerId, planId, providerId])).rows[0];
}

async function paid(customerId, id) {
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id
        ) VALUES('stripe',$1,'charge','succeeded',NOW()-INTERVAL '20 days','USD',600,20,580,$2)
    `, [id, customerId]);
}

async function voluntary(subscriptionId) {
    await query(`
        INSERT INTO audit_log(action,entity_type,entity_id,metadata)
        VALUES('billing.renewal.stop','subscription',$1,'{}'::jsonb)
    `, [String(subscriptionId)]);
}

function assertRecoveryEmail() {
    const message = winback.recoveryMessage(
        { offerDays: 7, trigger_reason: 'payment_failed' },
        { display_name: 'Taylor' },
        { siteName: 'CAPTAiNFiN', publicBaseUrl: 'https://portal.example.test' },
        {
            monthly: { code: 'WELCOME_BACK_25' },
            longterm: { code: 'WELCOME_BACK_10' }
        }
    );

    assert(message.subject.includes('CAPTAiNFiN'), 'win-back subject must carry the live brand');
    assert(message.subject.includes('25%') && message.subject.includes('10%'), 'subject must surface both comeback values');
    assert(message.text.includes('Hi Taylor'), 'plain-text fallback must keep the customer greeting');
    assert(message.text.includes('WELCOME_BACK_25') && message.text.includes('WELCOME_BACK_10'), 'plain-text fallback must carry both checkout codes');
    assert(message.text.includes('You can use one of these offers once.'), 'copy must make clear only one comeback option can be redeemed');
    assert(!message.text.includes('payment could not be renewed'), 'failed-payment recipients should receive positive comeback copy rather than a payment-failure reminder');

    assert(message.html.startsWith('<!doctype html>'), 'win-back email must render through the shared professional HTML template');
    assert(message.html.includes('max-width:640px'), 'win-back email must keep the shared professional card layout');
    assert(message.html.includes('Welcome-back offer'), 'win-back email must carry the shared event badge');
    assert(message.html.includes('A little something to welcome you back'), 'win-back email must use the approved conversion-focused heading');
    assert(message.html.includes('Monthly plan') && message.html.includes('25% off first payment'), 'monthly comeback option must be visually surfaced');
    assert(message.html.includes('6-month / yearly') && message.html.includes('10% off first term'), 'long-term comeback option must be visually surfaced');
    assert(message.html.includes('WELCOME_BACK_25') && message.html.includes('WELCOME_BACK_10'), 'HTML email must carry both checkout codes');
    assert(message.html.includes('See plans &amp; claim offer'), 'win-back email must have a clear account CTA');
    assert(message.html.includes('This marketing message was sent by CAPTAiNFiN.'), 'win-back email must retain the shared marketing footer');
}

(async () => {
    assertRecoveryEmail();

    const monthly = (await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,service_type)
        VALUES('winback-month','Winback Month','direct','month',30,600,'USD',3,'premium',TRUE,TRUE,'jellyfin')
        RETURNING id
    `)).rows[0];
    const yearly = (await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,service_type)
        VALUES('winback-year','Winback Year','direct','year',365,6000,'USD',3,'premium',TRUE,TRUE,'jellyfin')
        RETURNING id
    `)).rows[0];

    const paidVoluntary = await customer('Paid Voluntary');
    const neverPaid = await customer('Never Paid');
    const paidFailure = await customer('Paid Failure');
    const adminEnded = await customer('Admin Ended');

    const voluntarySub = await subscription({ customerId: paidVoluntary.id, planId: monthly.id, providerId: 'sub_winback_voluntary' });
    const neverPaidSub = await subscription({ customerId: neverPaid.id, planId: monthly.id, providerId: 'sub_winback_never_paid' });
    const failureSub = await subscription({ customerId: paidFailure.id, planId: monthly.id, providerId: 'sub_winback_failure' });
    const adminSub = await subscription({ customerId: adminEnded.id, planId: monthly.id, providerId: 'sub_winback_admin' });

    await paid(paidVoluntary.id, 'ch_winback_voluntary');
    await paid(paidFailure.id, 'ch_winback_failure');
    await paid(adminEnded.id, 'ch_winback_admin');
    await voluntary(voluntarySub.id);
    await voluntary(neverPaidSub.id);
    await voluntary(adminSub.id);
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('billing.subscription.terminate_local','subscription',$1,'{}'::jsonb)`, [String(adminSub.id)]);
    await failedRenewals.record({
        provider: 'stripe',
        eventId: 'evt_winback_failure',
        caseId: 'in_winback_failure',
        providerSubscriptionId: 'sub_winback_failure',
        amountMinor: 600,
        currency: 'USD'
    });

    const discovered = await winback.discoverCandidates({ limit: 50 });
    assert.strictEqual(discovered, 2, 'only verified prior payers with customer/payment terminal reasons should qualify');

    const offers = (await query(`SELECT customer_id,trigger_reason,status FROM winback_offers ORDER BY customer_id`)).rows;
    const byCustomer = new Map(offers.map(row => [String(row.customer_id), row]));
    assert.strictEqual(byCustomer.get(String(paidVoluntary.id))?.trigger_reason, 'voluntary_cancel');
    assert.strictEqual(byCustomer.get(String(paidFailure.id))?.trigger_reason, 'payment_failed');
    assert(!byCustomer.has(String(neverPaid.id)), 'a priced subscription without a verified successful payment qualified');
    assert(!byCustomer.has(String(adminEnded.id)), 'an administrative termination qualified as a voluntary win-back');

    assert.strictEqual(winback.planMatchesKind('monthly_25', { billing_interval: 'month' }), true);
    assert.strictEqual(winback.planMatchesKind('monthly_25', { billing_interval: 'year' }), false);
    assert.strictEqual(winback.planMatchesKind('longterm_10', { billing_interval: '6_months' }), true);
    assert.strictEqual(winback.planMatchesKind('longterm_10', { billing_interval: 'year' }), true);
    assert.strictEqual(winback.planMatchesKind('longterm_10', { billing_interval: 'month' }), false);

    await query(`
        UPDATE winback_offers
           SET status='sent',sent_at=NOW(),expires_at=NOW()+INTERVAL '7 days'
         WHERE customer_id=$1
    `, [paidVoluntary.id]);
    await winback.assertOfferEligibility({ query }, { kind: 'monthly_25', customerId: paidVoluntary.id, planId: monthly.id });
    await winback.assertOfferEligibility({ query }, { kind: 'longterm_10', customerId: paidVoluntary.id, planId: yearly.id });
    await assert.rejects(
        winback.assertOfferEligibility({ query }, { kind: 'monthly_25', customerId: paidVoluntary.id, planId: yearly.id }),
        error => error?.code === 'WINBACK_INTERVAL_NOT_ELIGIBLE'
    );

    // A second cancellation inside 90 days can be discovered, but the send
    // worker must suppress it before touching the email outbox.
    const secondSub = await subscription({ customerId: paidVoluntary.id, planId: monthly.id, providerId: 'sub_winback_second' });
    await voluntary(secondSub.id);
    assert.strictEqual(await winback.discoverCandidates({ limit: 50 }), 1);
    await query(`UPDATE winback_offers SET eligible_at=NOW()-INTERVAL '1 minute',next_attempt_at=NOW()-INTERVAL '1 minute' WHERE trigger_subscription_id=$1`, [secondSub.id]);
    const run = await winback.run({ limit: 10 });
    assert.strictEqual(run.suppressed, 1, 'a repeat win-back inside the cooldown was not suppressed');
    const second = (await query(`SELECT status,suppression_reason FROM winback_offers WHERE trigger_subscription_id=$1`, [secondSub.id])).rows[0];
    assert.strictEqual(second.status, 'suppressed');
    assert.strictEqual(second.suppression_reason, '90_day_cooldown');

    console.log('win-back offers database smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});