'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('PayPal return/webhook race smoke')) process.exit(0);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const lifecyclePrimitives = require('../src/payments/lifecycle-primitives');
const livePaypalHistory = require('../src/payments/live-paypal-payment-history');
const paymentReconciliation = require('../src/payments/provider-payment-reconciliation');
const providerCheckoutRecovery = require('../src/payments/provider-checkout-recovery');
const dashboardLedger = require('../src/payments/dashboard-ledger');

function expect(condition, message) { if (!condition) throw new Error(message); }

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Race Test',$1) RETURNING id`, [`race-${suffix}@example.invalid`])).rows[0];
    const other = (await query(`INSERT INTO customers(display_name,email) VALUES('Other',$1) RETURNING id`, [`race-other-${suffix}@example.invalid`])).rows[0];

    const created = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });
    const nonce = created.nonce;
    await intents.attachProviderCheckout(created.id, `PAYPAL-ORDER-${suffix}`);

    // Simulate a provider completion winning the race before the browser return.
    await intents.completeVerifiedProvider('paypal', `PAYPAL-ORDER-${suffix}`, 'completed');

    let verifyThrew = false;
    try {
        await intents.verify({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: customer.id });
    } catch (_) {
        verifyThrew = true;
    }
    expect(verifyThrew, 'verify() should still reject a non-open intent -- this smoke exists to check the fallback, not weaken verify().');

    const already = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: customer.id });
    expect(already, 'alreadyCompletedByOwner() must recognize a provider-completed intent so the return handler can redirect to success instead of a false expired/already-used error.');

    const wrongNonce = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce: 'not-the-real-nonce', scope: 'customer', provider: 'paypal', ownerId: customer.id });
    expect(wrongNonce === null, 'alreadyCompletedByOwner() must not be usable to probe intent state without the real nonce.');

    const wrongOwner = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: other.id });
    expect(wrongOwner === null, 'alreadyCompletedByOwner() must not leak another customer\'s completed checkout.');

    const returnSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'customer-payment-return.js'), 'utf8');
    expect(returnSource.includes('intents.alreadyCompletedByOwner'), 'the PayPal return route must fall back to alreadyCompletedByOwner() on a verify() failure.');

    // A provider transaction in one-time/payment mode is immutable. If activation
    // commits but a later accounting step fails, retrying the same capture must not
    // move starts_at/current_period_end forward.
    expect(lifecyclePrimitives.isHistoricalCheckoutReplay({ existingCount: 1, effectiveBillingMode: 'payment', settlementState: 'open' }) === true, 'an existing one-time provider payment must be treated as an idempotent replay even while checkout settlement is still open.');
    expect(lifecyclePrimitives.isHistoricalCheckoutReplay({ existingCount: 1, effectiveBillingMode: 'subscription', settlementState: 'open' }) === false, 'an open recurring subscription settlement must retain provider update semantics.');
    expect(lifecyclePrimitives.isHistoricalCheckoutReplay({ existingCount: 1, effectiveBillingMode: 'subscription', settlementState: 'completed' }) === true, 'a completed recurring checkout replay must remain historical/idempotent.');

    const capture = {
        id: `PAYPAL-CAPTURE-${suffix}`,
        status: 'COMPLETED',
        create_time: '2026-09-13T12:00:00Z',
        amount: { currency_code: 'USD', value: '30.00' },
        seller_receivable_breakdown: {
            paypal_fee: { currency_code: 'USD', value: '1.47' },
            net_amount: { currency_code: 'USD', value: '28.53' }
        },
        supplementary_data: { related_ids: { order_id: `PAYPAL-ORDER-${suffix}` } }
    };
    const history = livePaypalHistory.historyValues(capture, { customerId: customer.id, providerCustomerId: `PAYER-${suffix}` });
    expect(history.providerTransactionId === capture.id, 'PayPal capture ID must be the canonical ledger dedupe key.');
    expect(String(history.customerId) === String(customer.id), 'PayPal financial history must preserve the owning customer ID.');
    expect(history.providerCustomerId === `PAYER-${suffix}`, 'PayPal financial history must preserve the provider payer ID.');
    expect(history.grossMinor === 3000, '$30 PayPal payment must be recorded as 3000 minor units.');
    expect(history.feeMinor === 147, 'PayPal fee must come from seller_receivable_breakdown.');
    expect(history.netMinor === 2853, 'PayPal net proceeds must remain provider-authoritative.');
    expect(history.status === 'S', 'completed PayPal captures must use the canonical successful accounting status.');
    expect(paymentReconciliation.paypalCaptureOrderId(capture) === `PAYPAL-ORDER-${suffix}`, 'reconciliation must derive checkout ownership from the canonical order ID on the full capture.');
    expect(paymentReconciliation.paypalOrderReference({ referenceType: 'ODR', referenceId: 'ORDER-1' }) === 'ORDER-1', 'Transaction Search ODR references must be recognized as PayPal order IDs.');
    expect(paymentReconciliation.paypalOrderReference({ referenceType: 'TXN', referenceId: 'ORDER-1' }) === null, 'non-order PayPal reference types must never be matched to checkout order IDs.');

    const ranked = paymentReconciliation.prioritizePayPalCandidates([
        { id: 'UNRELATED' },
        { id: 'OWNED-CAPTURE' },
        { id: 'CHECKOUT-CAPTURE', referenceType: 'ODR', referenceId: 'LOCAL-ORDER' },
        { id: 'NON-ORDER-REFERENCE', referenceType: 'TXN', referenceId: 'LOCAL-ORDER' }
    ], new Map([['OWNED-CAPTURE', { customer_id: customer.id }]]), new Map([['LOCAL-ORDER', { customer_id: customer.id }]]));
    expect(ranked.slice(0, 2).map(row => row.id).join(',') === 'OWNED-CAPTURE,CHECKOUT-CAPTURE', 'PayPal repair must prioritize only safely locally-owned captures before unrelated provider traffic consumes the lookup budget.');
    expect(ranked[3].id === 'NON-ORDER-REFERENCE', 'a non-ODR PayPal reference must not be promoted as local checkout ownership evidence.');

    const cooldownNow = Date.now();
    const cooldownRow = { id: 'COOLDOWN-CAPTURE', referenceType: 'TXN', referenceId: 'LOCAL-ORDER' };
    paymentReconciliation.rememberUnmatchedPayPalCapture(cooldownRow.id, cooldownNow);
    expect(paymentReconciliation.paypalUnmatchedCoolingDown(cooldownRow, new Map(), new Map(), cooldownNow + 1000) === true, 'a recently inspected unmatched capture must be cooled down instead of refetched every integrity run.');
    const laterEvidenceRow = { id: cooldownRow.id, referenceType: 'ODR', referenceId: 'LOCAL-ORDER' };
    expect(paymentReconciliation.paypalUnmatchedCoolingDown(laterEvidenceRow, new Map(), new Map([['LOCAL-ORDER', { customer_id: customer.id }]]), cooldownNow + 1000) === false, 'new local ownership evidence must bypass the unmatched-capture cooldown immediately.');
    paymentReconciliation.clearUnmatchedPayPalCapture(cooldownRow.id);

    let activeLookups = 0, peakLookups = 0;
    await paymentReconciliation.forEachConcurrent(Array.from({ length: 12 }), 3, async () => {
        activeLookups += 1;
        peakLookups = Math.max(peakLookups, activeLookups);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeLookups -= 1;
    });
    expect(peakLookups > 1 && peakLookups <= 3, 'PayPal capture verification must be concurrent but remain inside its explicit concurrency bound.');

    expect(livePaypalHistory.historyValues({ ...capture, status: 'PENDING' }, { customerId: customer.id }) === null, 'pending PayPal captures must never become revenue.');
    expect(livePaypalHistory.historyValues({ ...capture, seller_receivable_breakdown: {} }, { customerId: customer.id }) === null, 'missing PayPal fee/net data must never be guessed.');
    expect(livePaypalHistory.historyValues({ ...capture, seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '-1.00' }, net_amount: { currency_code: 'USD', value: '31.00' } } }, { customerId: customer.id }) === null, 'negative PayPal fees must never be accepted as authoritative revenue data.');
    expect(livePaypalHistory.historyValues({ ...capture, seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: '31.00' }, net_amount: { currency_code: 'USD', value: '-1.00' } } }, { customerId: customer.id }) === null, 'fees above gross / negative net proceeds must never be booked.');

    // New canonical row: retries/redelivery must remain exactly-once and customer-attributed.
    await livePaypalHistory.upsertValues(history, { eventId: `EVENT-${suffix}` });
    await livePaypalHistory.upsertValues(history, { eventId: `EVENT-${suffix}` });
    const inserted = await query(`
        SELECT transaction_type,transaction_status,gross_amount_minor,fee_amount_minor,net_amount_minor,
               customer_id,provider_customer_id,metadata
        FROM payment_history_transactions
        WHERE provider='paypal' AND provider_transaction_id=$1
    `, [capture.id]);
    expect(inserted.rowCount === 1, 'PayPal capture retries must produce exactly one canonical financial row.');
    const recorded = inserted.rows[0];
    expect(recorded.transaction_type === 'T0006', 'new live PayPal captures must use the canonical customer-payment classification.');
    expect(recorded.transaction_status === 'S', 'new live PayPal captures must remain successful.');
    expect(Number(recorded.gross_amount_minor) === 3000 && Number(recorded.fee_amount_minor) === 147 && Number(recorded.net_amount_minor) === 2853, 'canonical financial row must preserve provider-authoritative gross/fee/net values.');
    expect(String(recorded.customer_id) === String(customer.id), 'canonical financial row must be attached to the owning customer.');
    expect(recorded.metadata?.providerAuthoritative === true && recorded.metadata?.feeDataAvailable === true, 'canonical financial row must be marked provider-authoritative for P&L accounting.');
    expect(recorded.metadata?.providerEventId === `EVENT-${suffix}`, 'provider event provenance must be retained on the canonical row.');
    expect(dashboardLedger.authoritativeLivePaypal({ provider: 'paypal', ...recorded }) === true, 'a valid authoritative PayPal payment must be eligible to suppress its duplicate webhook revenue event.');

    const recoveryCandidates = await providerCheckoutRecovery.candidates({ checkoutIntentIds: [created.id] });
    const paymentRecoveryCandidate = recoveryCandidates.find(row => String(row.id) === String(created.id));
    expect(paymentRecoveryCandidate?.checkout_mode === 'payment' && String(paymentRecoveryCandidate.paid_capture_id) === String(capture.id), 'an authoritative paid PayPal one-time checkout without a purchase must enter durable provider checkout recovery.');

    let paymentActivationCalls = 0;
    const paymentRecoveryResult = await providerCheckoutRecovery.recoverPayPal({
        checkout_mode: 'payment',
        provider_checkout_id: `PAYPAL-ORDER-${suffix}`,
        paid_capture_id: capture.id
    }, {
        paypalPaymentOrder: async () => ({
            id: `PAYPAL-ORDER-${suffix}`,
            status: 'COMPLETED',
            purchase_units: [{ payments: { captures: [{ id: capture.id, status: 'COMPLETED' }] } }]
        }),
        paypalActivatePayment: async () => { paymentActivationCalls += 1; }
    });
    expect(paymentRecoveryResult.state === 'recovered' && paymentActivationCalls === 1, 'paid one-time PayPal recovery must activate only after a completed provider order and exact capture match are verified.');

    let mismatchedRecoveryThrew = false;
    try {
        await providerCheckoutRecovery.recoverPayPal({
            checkout_mode: 'payment',
            provider_checkout_id: `PAYPAL-ORDER-${suffix}`,
            paid_capture_id: capture.id
        }, {
            paypalPaymentOrder: async () => ({
                id: `PAYPAL-ORDER-${suffix}`,
                status: 'COMPLETED',
                purchase_units: [{ payments: { captures: [{ id: `OTHER-CAPTURE-${suffix}`, status: 'COMPLETED' }] } }]
            }),
            paypalActivatePayment: async () => { paymentActivationCalls += 1; }
        });
    } catch (error) {
        mismatchedRecoveryThrew = /does not match the authoritative local payment/i.test(String(error?.message || error));
    }
    expect(mismatchedRecoveryThrew && paymentActivationCalls === 1, 'one-time recovery must refuse a provider order whose completed capture differs from the authoritative ledger row.');

    const authoritativeIds = await paymentReconciliation.authoritativePayPalCaptureIds([capture.id, `MISSING-${suffix}`]);
    expect(authoritativeIds.has(capture.id) && !authoritativeIds.has(`MISSING-${suffix}`), 'reconciliation must recognize already-authoritative captures so scheduled repair does not refetch them every run.');

    // Metadata flags alone are not enough: malformed/non-payment rows must neither
    // suppress valid webhook revenue nor escape scheduled repair.
    const malformedCaptureId = `PAYPAL-MALFORMED-${suffix}`;
    const authoritativeMeta = JSON.stringify({ providerAuthoritative: true, feeDataAvailable: true });
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata
        ) VALUES('paypal',$1,'T9999','S',$2,'USD',3000,147,2853,$3,$4::jsonb)
    `, [malformedCaptureId, capture.create_time, customer.id, authoritativeMeta]);
    const malformedIds = await paymentReconciliation.authoritativePayPalCaptureIds([malformedCaptureId]);
    expect(!malformedIds.has(malformedCaptureId), 'malformed metadata-flagged PayPal rows must remain eligible for scheduled repair.');
    expect(dashboardLedger.authoritativeLivePaypal({
        provider: 'paypal', provider_transaction_id: malformedCaptureId, transaction_type: 'T9999', transaction_status: 'S',
        gross_amount_minor: 3000, metadata: { providerAuthoritative: true, feeDataAvailable: true }
    }) === false, 'malformed metadata-flagged PayPal rows must not suppress a valid PAYMENT.CAPTURE.COMPLETED event.');

    // Existing rows may preserve a richer type only when that type is still a
    // canonical PayPal payment. An unknown type must not suppress the webhook and
    // then disappear from P&L.
    const legacyCaptureId = `PAYPAL-LEGACY-${suffix}`;
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata
        ) VALUES('paypal',$1,'T9999','S',$2,'USD',3000,147,2853,$3,'{}'::jsonb)
    `, [legacyCaptureId, capture.create_time, customer.id]);
    const legacyValues = { ...history, providerTransactionId: legacyCaptureId };
    await livePaypalHistory.upsertValues(legacyValues, { eventId: `RECON-EVENT-${suffix}`, reconciliation: true });
    await livePaypalHistory.upsertValues(legacyValues);
    const repaired = (await query(`
        SELECT transaction_type,customer_id,metadata
        FROM payment_history_transactions
        WHERE provider='paypal' AND provider_transaction_id=$1
    `, [legacyCaptureId])).rows[0];
    expect(repaired.transaction_type === 'T0006', 'an incompatible historical PayPal type must be normalized to the canonical completed-capture payment type.');
    expect(String(repaired.customer_id) === String(customer.id), 'live reconciliation must preserve customer ownership.');
    expect(repaired.metadata?.providerAuthoritative === true && repaired.metadata?.feeDataAvailable === true && repaired.metadata?.reconciled === true, 'live reconciliation must enrich existing metadata with authoritative accounting flags.');
    expect(repaired.metadata?.providerEventId === `RECON-EVENT-${suffix}`, 'a later retry without an event ID must not erase recorded provider-event provenance.');

    const compatibleCaptureId = `PAYPAL-COMPAT-${suffix}`;
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata
        ) VALUES('paypal',$1,'T0004','S',$2,'USD',3000,147,2853,$3,'{}'::jsonb)
    `, [compatibleCaptureId, capture.create_time, customer.id]);
    await livePaypalHistory.upsertValues({ ...history, providerTransactionId: compatibleCaptureId });
    const compatibleType = (await query(`SELECT transaction_type FROM payment_history_transactions WHERE provider='paypal' AND provider_transaction_id=$1`, [compatibleCaptureId])).rows[0]?.transaction_type;
    expect(compatibleType === 'T0004', 'a recognized imported PayPal payment classification should be preserved during live enrichment.');

    // A verified capture must never silently inherit a conflicting existing customer owner.
    const conflictCaptureId = `PAYPAL-CONFLICT-${suffix}`;
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata
        ) VALUES('paypal',$1,'T0006','S',$2,'USD',3000,147,2853,$3,'{}'::jsonb)
    `, [conflictCaptureId, capture.create_time, other.id]);
    let conflictThrew = false;
    try {
        await livePaypalHistory.assertCaptureOwner(conflictCaptureId, customer.id);
    } catch (error) {
        conflictThrew = /customer owner/i.test(String(error?.message || error));
    }
    expect(conflictThrew, 'capture ownership must be rejectable before entitlement or checkout state is mutated.');
    conflictThrew = false;
    try {
        await livePaypalHistory.upsertValues({ ...history, providerTransactionId: conflictCaptureId });
    } catch (error) {
        conflictThrew = /customer owner/i.test(String(error?.message || error));
    }
    expect(conflictThrew, 'a canonical PayPal transaction already owned by a different customer must raise an integrity conflict.');
    const conflictOwner = (await query(`SELECT customer_id FROM payment_history_transactions WHERE provider='paypal' AND provider_transaction_id=$1`, [conflictCaptureId])).rows[0]?.customer_id;
    expect(String(conflictOwner) === String(other.id), 'an ownership conflict must never silently reassign the historical financial row.');

    const ledgerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'live-paypal-payment-history.js'), 'utf8');
    const paypalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'paypal.js'), 'utf8');
    const reconciliationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'provider-payment-reconciliation.js'), 'utf8');
    const checkoutRecoverySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'provider-checkout-recovery.js'), 'utf8');
    const jobsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'automation', 'jobs.js'), 'utf8');
    const completedOrderStart = paypalSource.indexOf('async function activateCompletedOrder(order)');
    const completedOrderEnd = paypalSource.indexOf('async function captureOrder(orderId)', completedOrderStart);
    const completedOrderSource = paypalSource.slice(completedOrderStart, completedOrderEnd);
    expect(ledgerSource.includes('ON CONFLICT(provider,provider_transaction_id) DO UPDATE'), 'PayPal retries must upsert rather than double count.');
    expect(ledgerSource.includes("LIVE_CAPTURE_PAYMENT_TYPE = 'T0006'"), 'live PayPal captures must have a safe canonical fallback classification.');
    expect(ledgerSource.includes('PAYPAL_PAYMENT_CODES'), 'live repair must only preserve transaction types that the canonical PayPal classifier recognizes as payments.');
    expect(ledgerSource.includes('providerAuthoritative: true'), 'provider-verified PayPal rows must be marked authoritative.');
    expect(ledgerSource.includes('assertCaptureOwner'), 'PayPal capture ownership must have a preflight integrity guard.');
    expect(!/INSERT\s+INTO\s+subscriptions/i.test(ledgerSource), 'accounting sync must never create entitlement state.');
    expect(!/UPDATE\s+subscriptions/i.test(ledgerSource), 'accounting sync must never mutate entitlement state.');
    expect(paypalSource.includes('existingCapture.rowCount?null:payerId'), 'a historical one-time PayPal replay must not overwrite a newer payer identity.');
    expect(completedOrderSource.indexOf("completeVerifiedProvider('paypal',order.id,'completed')") < completedOrderSource.indexOf('recordCompletedCapture(capture'), 'the local checkout must be completed before ledger persistence so an accounting failure cannot leave a paid checkout open.');
    expect(completedOrderSource.includes('await recordCompletedCapture(capture'), 'the common completed-order path must persist the authoritative PayPal capture.');
    expect(completedOrderSource.includes('livePaypalHistory.assertCaptureOwner(providerId,mapping.customerId)'), 'capture ownership must be checked before the common PayPal activation path mutates local state.');
    expect(reconciliationSource.includes("providerHttp.fetchJson('paypal'"), 'scheduled PayPal reconciliation must use the canonical provider HTTP timeout/bounds layer.');
    expect(reconciliationSource.includes("referenceType || '').trim().toUpperCase() !== 'ODR'"), 'Transaction Search checkout ownership must only trust ODR order references.');
    expect(reconciliationSource.indexOf('const prioritizedPending = prioritizePayPalCandidates') < reconciliationSource.indexOf('const candidates = eligiblePending.slice'), 'the reconciliation budget must be applied after local ownership evidence is ranked and cooled-down unrelated captures are removed.');
    expect(reconciliationSource.includes('PAYPAL_CAPTURE_LOOKUP_CONCURRENCY = 8') && reconciliationSource.includes('forEachConcurrent(candidates, PAYPAL_CAPTURE_LOOKUP_CONCURRENCY'), 'provider capture lookups must have an explicit concurrency bound rather than running hundreds of sequential timeout windows.');
    expect(reconciliationSource.includes('PAYPAL_UNMATCHED_RECHECK_MS'), 'unmatched provider captures must be cooled down rather than detail-fetched on every integrity run.');
    expect(reconciliationSource.includes('const canonicalOrderId = paypalCaptureOrderId(capture);'), 'reconciliation must map checkout ownership from the full capture order ID before falling back to Transaction Search metadata.');
    expect(!reconciliationSource.includes("completeVerifiedProvider('paypal'"), 'accounting reconciliation must never mark a checkout fulfilled without creating the corresponding purchase/entitlement.');
    expect(reconciliationSource.includes('fulfillmentPending'), 'paid captures matched only through checkout intent must remain visibly pending fulfillment instead of being silently completed.');
    expect(reconciliationSource.includes('assertCaptureOwner(row.id, local.customer_id)'), 'reconciliation must reject a conflicting ledger owner before booking provider accounting.');
    expect(checkoutRecoverySource.includes("i.checkout_mode='payment'"), 'provider checkout recovery must include paid one-time PayPal checkouts.');
    expect(checkoutRecoverySource.includes("ph.metadata->>'livePaypal'='true'") && checkoutRecoverySource.includes("ph.metadata->>'providerAuthoritative'='true'"), 'one-time fulfillment recovery must require authoritative live PayPal accounting proof.');
    expect(checkoutRecoverySource.includes('s.provider_subscription_id=ph.provider_transaction_id'), 'one-time recovery must exclude captures whose purchase already exists.');
    expect(checkoutRecoverySource.includes("status !== 'COMPLETED'") && checkoutRecoverySource.includes('String(capture.id) !== String(row.paid_capture_id)'), 'one-time recovery must reverify provider completion and exact capture identity before activation.');
    expect(jobsSource.includes('syncRecentPayPalHistory({hours:72,limit:100})'), 'scheduled PayPal reconciliation must keep provider capture detail work to a bounded batch.');
    expect(jobsSource.includes('revenueIntegritySafeRun()'), 'PayPal reconciliation must preserve the bounded DB-pressure-safe revenue-integrity path from main.');
    expect(jobsSource.includes('paypalHistoryDegraded'), 'unmatched/truncated PayPal reconciliation must make the automation visibly degraded.');
    expect(jobsSource.includes('transientDatabasePressure(detail)'), 'transient local DB pressure must remain suppressed rather than becoming a false PayPal integrity alert.');

    console.log('PayPal return/accounting race smoke test passed.');
}

main().finally(() => getPool().end());