'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('provider financial truth DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const { getPool } = require('../src/db');
const financialTruth = require('../src/payments/provider-financial-truth');

async function main() {
  const client = await getPool().connect();
  const suffix = crypto.randomBytes(6).toString('hex');
  const emailA = 'provider-truth-a-' + suffix + '@example.invalid';
  const emailB = 'provider-truth-b-' + suffix + '@example.invalid';
  try {
    const a = (await client.query(
      'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
      ['Provider truth A ' + suffix, emailA]
    )).rows[0].id;
    const b = (await client.query(
      'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
      ['Provider truth B ' + suffix, emailB]
    )).rows[0].id;

    const stripeCustomer = 'cus_' + suffix;
    await client.query(
      "INSERT INTO payment_customers(customer_id,provider,provider_customer_id) VALUES($1,'stripe',$2)",
      [a, stripeCustomer]
    );
    await client.query(
      "INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,customer_id,metadata) VALUES('stripe',$1,'charge','available',NOW(),'GBP',500,25,475,$2,NULL,'{}'::jsonb)",
      ['txn_unowned_' + suffix, stripeCustomer]
    );

    const repaired = await financialTruth.repairOwnership({ customerId: a });
    assert(repaired.linked >= 1, 'known Stripe customer identity must reconnect an unowned ledger transaction');
    const linked = await client.query(
      "SELECT customer_id FROM payment_history_transactions WHERE provider='stripe' AND provider_transaction_id=$1",
      ['txn_unowned_' + suffix]
    );
    assert.strictEqual(String(linked.rows[0]?.customer_id), String(a));

    await financialTruth.rememberIdentity({
      provider: 'stripe',
      customerId: a,
      resourceType: financialTruth.RESOURCE_TYPES.REFERENCE,
      providerIdentity: 'pi_' + suffix,
      source: 'db_smoke'
    });
    assert.strictEqual(
      String(await financialTruth.resolveCustomerId({
        provider: 'stripe',
        providerReferenceId: 'pi_' + suffix
      })),
      String(a),
      'canonical identity graph must resolve provider references independently of subscriptions'
    );

    await financialTruth.upsertTransaction({
      provider: 'plisio',
      providerTransactionId: 'plisio_' + suffix,
      transactionType: 'payment',
      transactionStatus: 'completed',
      occurredAt: new Date(),
      currency: 'GBP',
      grossMinor: 600,
      feeMinor: 0,
      netMinor: 600,
      customerId: a,
      providerBillingReference: 'plisio_' + suffix,
      metadata: { providerAuthoritative: true, feeDataAvailable: false },
      identitySource: 'db_smoke'
    });
    const plisio = await client.query(
      "SELECT customer_id,gross_amount_minor,transaction_type FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1",
      ['plisio_' + suffix]
    );
    assert.strictEqual(String(plisio.rows[0]?.customer_id), String(a));
    assert.strictEqual(Number(plisio.rows[0]?.gross_amount_minor), 600);
    assert.strictEqual(plisio.rows[0]?.transaction_type, 'payment');

    const immutableId = 'txn_authoritative_' + suffix;
    await financialTruth.upsertTransaction({
      provider: 'stripe',
      providerTransactionId: immutableId,
      transactionType: 'charge',
      transactionStatus: 'available',
      currency: 'GBP',
      grossMinor: 1000,
      feeMinor: 59,
      netMinor: 941,
      customerId: a,
      metadata: { providerAuthoritative: true, feeDataAvailable: true }
    });
    await financialTruth.upsertTransaction({
      provider: 'stripe',
      providerTransactionId: immutableId,
      transactionType: 'charge',
      transactionStatus: 'succeeded',
      currency: 'GBP',
      grossMinor: 999,
      feeMinor: 0,
      netMinor: 999,
      customerId: a,
      metadata: { providerAuthoritative: false, feeDataAvailable: false }
    });
    const authoritative = await client.query(
      "SELECT gross_amount_minor,fee_amount_minor,net_amount_minor FROM payment_history_transactions WHERE provider='stripe' AND provider_transaction_id=$1",
      [immutableId]
    );
    assert.deepStrictEqual(
      [
        Number(authoritative.rows[0].gross_amount_minor),
        Number(authoritative.rows[0].fee_amount_minor),
        Number(authoritative.rows[0].net_amount_minor)
      ],
      [1000,59,941],
      'lower-quality webhook evidence must never overwrite provider-authoritative accounting'
    );

    await assert.rejects(
      financialTruth.upsertTransaction({
        provider: 'stripe',
        providerTransactionId: immutableId,
        transactionType: 'charge',
        transactionStatus: 'available',
        currency: 'GBP',
        grossMinor: 1000,
        feeMinor: 59,
        netMinor: 941,
        customerId: b,
        metadata: { providerAuthoritative: true }
      }),
      error => error?.code === 'PROVIDER_TRANSACTION_OWNER_CONFLICT',
      'one provider transaction must never move between customer owners'
    );

    await assert.rejects(
      financialTruth.rememberIdentity({
        provider: 'stripe',
        customerId: b,
        resourceType: financialTruth.RESOURCE_TYPES.REFERENCE,
        providerIdentity: 'pi_' + suffix,
        source: 'db_smoke_conflict'
      }),
      error => error?.code === 'PROVIDER_IDENTITY_CONFLICT',
      'one canonical provider identity must never be assigned to two customers'
    );

    console.log('provider financial truth DB smoke: ok');
  } finally {
    await client.query('DELETE FROM customers WHERE email IN ($1,$2)', [emailA,emailB]).catch(() => {});
    client.release();
  }
}

main().catch(error => {
  console.error('provider financial truth DB smoke failed:', error);
  process.exitCode = 1;
}).finally(() => getPool().end());
