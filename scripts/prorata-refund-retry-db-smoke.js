'use strict';
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('pro-rata refund retry DB smoke')) process.exit(0);
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const refunds = require('../src/payments/prorata-refunds');
const contract = require('../src/payments/provider-contract');
const provisioning = require('../src/jellyfin/resilient-provisioning');

async function main() {
  const suffix = crypto.randomBytes(8).toString('hex');
  const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Refund retry',$1) RETURNING id`, [`refund-retry-${suffix}@example.invalid`])).rows[0];
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,active,visible)
    VALUES($1,'Refund retry','jellyfin','direct','month',30,10000,'GBP',TRUE,TRUE) RETURNING id`, [`refund-retry-${suffix}`])).rows[0];
  const originalRefunds = contract.refunds;
  const originalReconcile = provisioning.reconcileCustomer;
  const RealDate = Date;
  provisioning.reconcileCustomer = async () => ({ active: false });
  try {
    for (const provider of ['stripe', 'paypal']) {
      const subscription = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
        VALUES($1,$2,'active',$3,$4,NOW()-INTERVAL '15 days',NOW()+INTERVAL '15 days',10000,'GBP','jellyfin',$5::jsonb) RETURNING *`,
      [customer.id, plan.id, provider, `${provider === 'stripe' ? 'pi_' : 'CAPTURE-'}retry_${suffix}`, JSON.stringify({ discountedMinor: 8000, serviceCreditMinor: 2000, currency: 'GBP', checkoutMode: 'payment' })])).rows[0];
      const issued = new Map();
      let providerCalls = 0;
      let loseFirstResponse = true;
      contract.refunds = name => {
        assert.equal(name, provider);
        return {
          isComplete: status => status === 'succeeded',
          createOrObserve: async (operation, request) => {
            providerCalls++;
            let remote = issued.get(operation.idempotency_key);
            if (!remote) {
              remote = { id: `refund-${issued.size + 1}`, status: 'succeeded', raw: {}, amount: request.refundMinor };
              issued.set(operation.idempotency_key, remote);
            }
            if (loseFirstResponse) {
              loseFirstResponse = false;
              throw Object.assign(new Error('Provider succeeded but response was lost'), { code: 'ETIMEDOUT' });
            }
            return remote;
          }
        };
      };
      await assert.rejects(refunds.execute({ subscriptionId: subscription.id, reason: 'Unused service refund' }), /response was lost/);
      const first = (await query(`SELECT * FROM provider_operations WHERE operation_type='prorata_refund' AND local_reference=$1`, [subscription.id])).rows[0];
      assert.equal(first.state, 'planned');
      const reviewRequired = error => error.code === 'PRORATA_REFUND_REVIEW_REQUIRED';
      await query(`UPDATE provider_operations SET manual_review_required=TRUE WHERE id=$1`, [first.id]);
      await assert.rejects(refunds.execute({ subscriptionId: subscription.id, reason: 'Retry manual case' }), reviewRequired);
      await query(`UPDATE provider_operations SET manual_review_required=FALSE,created_at=NOW()-INTERVAL '2 days' WHERE id=$1`, [first.id]);
      await assert.rejects(refunds.execute({ subscriptionId: subscription.id, reason: 'Retry stale unknown result' }), reviewRequired);
      const stale = (await query('SELECT * FROM provider_operations WHERE id=$1', [first.id])).rows[0];
      assert.equal(stale.manual_review_required, true, 'stale unknown provider outcomes must become operator-visible');
      assert.equal(providerCalls, 1, 'manual and expired idempotency cases must never send another refund');
      await query(`UPDATE provider_operations SET state='planned',manual_review_required=FALSE,created_at=$2 WHERE id=$1`, [first.id, first.created_at]);
      const duplicate = (await query(`INSERT INTO provider_operations(provider,scope,owner_id,operation_type,local_reference,idempotency_key,request_snapshot,state)
        SELECT provider,scope,owner_id,operation_type,local_reference,idempotency_key||'-legacy-duplicate',request_snapshot,'planned'
        FROM provider_operations WHERE id=$1 RETURNING *`, [first.id])).rows[0];
      await assert.rejects(refunds.execute({ subscriptionId: subscription.id, reason: 'Retry ambiguous legacy operations' }), reviewRequired);
      await assert.rejects(refunds.recoverProviderOperation(duplicate), reviewRequired);
      assert.equal(providerCalls, 1, 'automatic recovery must also refuse ambiguous legacy duplicates');
      await query('DELETE FROM provider_operations WHERE id=$1', [duplicate.id]);
      // Old deployments used a quote-dependent key. Recover that exact key too.
      const legacyKey = `${first.idempotency_key}-legacy`;
      issued.set(legacyKey, issued.get(first.idempotency_key));
      issued.delete(first.idempotency_key);
      await query('UPDATE provider_operations SET idempotency_key=$2 WHERE id=$1', [first.id, legacyKey]);
      // Advance confirmation time enough to change the rounded cash quote.
      const later = RealDate.now() + 3600000;
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [later])); }
        static now() { return later; }
      };
      const concurrent = await Promise.all(Array.from({ length: 3 }, () => refunds.execute({ subscriptionId: subscription.id, reason: 'Retry uncertain refund' })));
      const resumed = concurrent[0];
      global.Date = RealDate;
      assert.equal(issued.size, 1, `${provider}: a delayed retry must not issue a second cash refund`);
      assert.equal(resumed.operation.id, first.id, `${provider}: resume the durable operation instead of re-quoting`);
      assert.equal(resumed.operation.state, 'reconciled');
      assert(concurrent.every(item => item.operation.id === first.id && item.operation.state === 'reconciled'));
      assert.equal(resumed.quote.refundMinor, first.request_snapshot.refundMinor, 'the original cash decision must remain frozen');
      assert(resumed.quote.refundMinor <= 4000, 'cash refund excludes the service-credit portion');
      const callsBeforeCompletedRetry = providerCalls;
      const repeated = await Promise.all(Array.from({ length: 3 }, () => refunds.execute({ subscriptionId: subscription.id, reason: 'Repeat completed confirmation' })));
      assert(repeated.every(item => item.alreadyCompleted && item.operation.id === first.id));
      assert.equal(providerCalls, callsBeforeCompletedRetry, 'completed retries must never contact the provider again');
      // A persisted provider reference remains safe to observe after the retry
      // window: simulate a crash after the provider reply and before local apply.
      await query(`UPDATE provider_operations SET state='provider_applied',created_at=NOW()-INTERVAL '2 days' WHERE id=$1`, [first.id]);
      const known = await refunds.execute({ subscriptionId: subscription.id, reason: 'Observe known old refund' });
      assert.equal(known.operation.state, 'reconciled');
      assert.equal(issued.size, 1, 'a known remote refund must remain recoverable without issuing more cash');
      const count = (await query(`SELECT COUNT(*)::int AS n FROM provider_operations WHERE operation_type='prorata_refund' AND local_reference=$1`, [subscription.id])).rows[0].n;
      assert.equal(count, 1, 'one subscription refund must retain one durable operation');
    }
  } finally {
    global.Date = RealDate;
    contract.refunds = originalRefunds;
    provisioning.reconcileCustomer = originalReconcile;
  }
  console.log('pro-rata refund retry DB smoke: ok (Stripe/PayPal response loss, stale/ambiguous outcomes, legacy keys, elapsed quote, concurrent retries)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => getPool().end());
