'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const metrics = require('../src/platform/operational-metrics');

const suffix = crypto.randomBytes(5).toString('hex');
let customerId = null;
let providerOperationId = null;
let paymentEventId = null;

(async () => {
  try {
    const customer = await query(
      'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
      [`Operational metrics ${suffix}`, `operational-${suffix}@example.invalid`]
    );
    customerId = customer.rows[0].id;

    const payment = await query(`
      INSERT INTO payment_events(provider,event_id,event_type,processing_error)
      VALUES('stripe',$1,'fixture.retry','fixture retry failure') RETURNING id
    `, [`operational-${suffix}`]);
    paymentEventId = payment.rows[0].id;

    const operation = await query(`
      INSERT INTO provider_operations(provider,scope,owner_id,operation_type,idempotency_key,state,failure_kind,manual_review_required,next_attempt_at)
      VALUES('stripe','customer',$1,'fixture_recovery',$2,'planned','retryable',FALSE,NOW()) RETURNING id
    `, [customerId, `operational-${suffix}`]);
    providerOperationId = operation.rows[0].id;

    await query(`
      INSERT INTO automatic_free_downgrade_retries(customer_id,last_error,next_attempt_at)
      VALUES($1,'fixture downgrade retry',NOW())
    `, [customerId]);
    await query(`
      INSERT INTO customer_provisioning_state(customer_id,status,last_error,next_attempt_at)
      VALUES($1,'failed','fixture provisioning failure',NOW())
      ON CONFLICT(customer_id) DO UPDATE SET status='failed',last_error='fixture provisioning failure',next_attempt_at=NOW()
    `, [customerId]);

    const snapshot = await metrics.backlogSnapshot();
    assert.strictEqual(snapshot.available, true);
    assert(snapshot.paymentEventRetries >= 1, 'payment-event retry backlog must be counted');
    assert(snapshot.providerRecovery >= 1, 'provider recovery backlog must be counted');
    assert(snapshot.freeDowngradeRetries >= 1, 'automatic Free downgrade backlog must be counted');
    assert(snapshot.freeDowngradeDue >= 1, 'due automatic Free downgrade backlog must be counted');
    assert(snapshot.provisioningProblems >= 1, 'blocked/failed provisioning state must be counted');

    const support = metrics.supportSnapshot({ databasePool: metrics.poolSnapshot(), reconciliation: {}, backlog: snapshot });
    assert.strictEqual(support.backlog.available, true);
    assert(Number.isFinite(support.databasePool.total));
    assert(!JSON.stringify(support).includes(customerId), 'sanitized support counters must not expose customer identity');

    console.log('operational metrics DB smoke: ok');
  } finally {
    if (customerId) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    if (providerOperationId) await query('DELETE FROM provider_operations WHERE id=$1', [providerOperationId]).catch(() => {});
    if (paymentEventId) await query('DELETE FROM payment_events WHERE id=$1', [paymentEventId]).catch(() => {});
  }
})().finally(() => getPool().end()).catch(error => {
  console.error('operational metrics DB smoke failed:', error.message);
  process.exit(1);
});
