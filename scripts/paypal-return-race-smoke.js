'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('PayPal return/webhook race smoke')) process.exit(0);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const livePaypalHistory = require('../src/payments/live-paypal-payment-history');

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

    // Existing/imported row: live repair may enrich financial data/metadata but must
    // not erase the richer historical transaction classification. The schema makes
    // metadata NOT NULL, so use an empty object to exercise enrichment safely.
    const legacyCaptureId = `PAYPAL-LEGACY-${suffix}`;
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata
        ) VALUES('paypal',$1,'T9999','S',$2,'USD',3000,147,2853,$3,'{}'::jsonb)
    `, [legacyCaptureId, capture.create_time, customer.id]);
    const legacyValues = { ...history, providerTransactionId: legacyCaptureId };
    await livePaypalHistory.upsertValues(legacyValues, { reconciliation: true });
    const repaired = (await query(`
        SELECT transaction_type,customer_id,metadata
        FROM payment_history_transactions
        WHERE provider='paypal' AND provider_transaction_id=$1
    `, [legacyCaptureId])).rows[0];
    expect(repaired.transaction_type === 'T9999', 'live reconciliation must preserve an existing imported PayPal transaction classification.');
    expect(String(repaired.customer_id) === String(customer.id), 'live reconciliation must preserve customer ownership.');
    expect(repaired.metadata?.providerAuthoritative === true && repaired.metadata?.feeDataAvailable === true && repaired.metadata?.reconciled === true, 'live reconciliation must enrich existing metadata with authoritative accounting flags.');

    const ledgerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'live-paypal-payment-history.js'), 'utf8');
    const paypalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'paypal.js'), 'utf8');
    expect(ledgerSource.includes('ON CONFLICT(provider,provider_transaction_id) DO UPDATE'), 'PayPal retries must upsert rather than double count.');
    expect(ledgerSource.includes("LIVE_CAPTURE_PAYMENT_TYPE = 'T0006'"), 'live PayPal captures must have a safe canonical fallback classification.');
    expect(ledgerSource.includes('providerAuthoritative: true'), 'provider-verified PayPal rows must be marked authoritative.');
    expect(!/INSERT\s+INTO\s+subscriptions/i.test(ledgerSource), 'accounting sync must never create entitlement state.');
    expect(!/UPDATE\s+subscriptions/i.test(ledgerSource), 'accounting sync must never mutate entitlement state.');
    expect(paypalSource.includes('await recordCompletedCapture(capture'), 'the common completed-order path must persist the authoritative PayPal capture.');
    expect(paypalSource.includes('async function activateCompletedOrder(order)'), 'PayPal accounting persistence must remain attached to the common completed-order activation path.');

    console.log('PayPal return/accounting race smoke test passed.');
}

main().finally(() => getPool().end());
