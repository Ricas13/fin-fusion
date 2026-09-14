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

    const authoritativeIds = await paymentReconciliation.authoritativePayPalCaptureIds([capture.id, `MISSING-${suffix}`]);
    expect(authoritativeIds.has(capture.id) && !authoritativeIds.has(`MISSING-${suffix}`), 'reconciliation must recognize already-authoritative captures so scheduled repair does not refetch them every run.');

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
    const jobsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'automation', 'jobs.js'), 'utf8');
    expect(ledgerSource.includes('ON CONFLICT(provider,provider_transaction_id) DO UPDATE'), 'PayPal retries must upsert rather than double count.');
    expect(ledgerSource.includes("LIVE_CAPTURE_PAYMENT_TYPE = 'T0006'"), 'live PayPal captures must have a safe canonical fallback classification.');
    expect(ledgerSource.includes('PAYPAL_PAYMENT_CODES'), 'live repair must only preserve transaction types that the canonical PayPal classifier recognizes as payments.');
    expect(ledgerSource.includes('providerAuthoritative: true'), 'provider-verified PayPal rows must be marked authoritative.');
    expect(!/INSERT\s+INTO\s+subscriptions/i.test(ledgerSource), 'accounting sync must never create entitlement state.');
    expect(!/UPDATE\s+subscriptions/i.test(ledgerSource), 'accounting sync must never mutate entitlement state.');
    expect(paypalSource.includes('existingCapture.rowCount?null:payerId'), 'a historical one-time PayPal replay must not overwrite a newer payer identity.');
    expect(paypalSource.indexOf("completeVerifiedProvider('paypal',order.id,'completed')") < paypalSource.indexOf('recordCompletedCapture(capture'), 'the local checkout must be completed before ledger persistence so an accounting failure cannot leave a paid checkout open.');
    expect(paypalSource.includes('await recordCompletedCapture(capture'), 'the common completed-order path must persist the authoritative PayPal capture.');
    expect(paypalSource.includes('async function activateCompletedOrder(order)'), 'PayPal accounting persistence must remain attached to the common completed-order activation path.');
    expect(reconciliationSource.includes("providerHttp.fetchJson('paypal'"), 'scheduled PayPal reconciliation must use the canonical provider HTTP timeout/bounds layer.');
    expect(reconciliationSource.indexOf('const allPending = allCandidates.filter') < reconciliationSource.indexOf('const candidates = allPending.slice'), 'the reconciliation limit must be applied after already-authoritative captures are removed so older gaps cannot starve forever.');
    expect(reconciliationSource.includes("completeVerifiedProvider('paypal', row.referenceId, 'completed')"), 'reconciliation must repair a paid one-time checkout that was left locally open.');
    expect(jobsSource.includes('revenueIntegritySafeRun()'), 'PayPal reconciliation must preserve the bounded DB-pressure-safe revenue-integrity path from main.');
    expect(jobsSource.includes('paypalHistoryDegraded'), 'unmatched/truncated PayPal reconciliation must make the automation visibly degraded.');
    expect(jobsSource.includes('transientDatabasePressure(detail)'), 'transient local DB pressure must remain suppressed rather than becoming a false PayPal integrity alert.');

    console.log('PayPal return/accounting race smoke test passed.');
}

main().finally(() => getPool().end());
