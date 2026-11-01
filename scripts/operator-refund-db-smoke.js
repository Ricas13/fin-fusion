'use strict';

// A refund made outside the app (provider dashboard or cash) can be recorded by an administrator.
// A full refund ends the plan like a provider refund; a partial refund only records the money.
// Everything needs a reason and is audited, and a plan belonging to another customer is refused.

require('dotenv').config();
const assert = require('assert');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('operator refund DB smoke')) process.exit(0);

const { query, getPool } = require('../src/db');
const crypto = require('crypto');
const operatorRefund = require('../src/payments/operator-refund');
const { historyKind } = require('../src/payments/provider-transaction-classifier');
const financialState = require('../src/payments/provider-financial-state');
const referrals = require('../src/referrals');
const { unique, fixtureCustomer, fixturePlan, fixtureSubscription } = require('./test-fixture');

const created = { customers: [], plans: [] };

async function main() {
    const owner = await fixtureCustomer({ query }, { displayName: 'Refund Owner', email: `${unique('refund-owner')}@example.invalid` });
    const other = await fixtureCustomer({ query }, { displayName: 'Refund Other', email: `${unique('refund-other')}@example.invalid` });
    created.customers.push(owner.id, other.id);
    const plan = await fixturePlan({ query }, { code: unique('refund-plan'), name: 'Refund Plan', serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 1000, currency: 'GBP', streams: 1, serverClass: 'premium' });
    created.plans.push(plan.id);
    const txn = unique('plisio-refund');
    const providerSub = await fixtureSubscription({ query }, { customerId: owner.id, planId: plan.id, source: 'plisio', billingMode: 'payment', providerSubscriptionId: txn });
    const manualSub = await fixtureSubscription({ query }, { customerId: other.id, planId: plan.id, source: 'admin_grant' });
    const reason = 'Refunded in the Plisio dashboard after a duplicate payment';

    const sid = () => crypto.randomUUID();
    const base = { customerId: owner.id, subscriptionId: providerSub.id, reason };

    // Guards.
    await assert.rejects(() => operatorRefund.record({ ...base, amount: '10.00', reason: 'short', submissionId: sid() }), /reason/i);
    await assert.rejects(() => operatorRefund.record({ ...base, amount: '10.00', submissionId: 'nope' }), /expired/i, 'a form without a valid submission id is refused');
    for (const bad of ['0', '0.001', '4.00abc', '-5', '1e3', '']) {
        await assert.rejects(() => operatorRefund.record({ ...base, amount: bad, submissionId: sid() }), /amount|number|least/i, `amount "${bad}" must be refused`);
    }
    await assert.rejects(() => operatorRefund.record({ ...base, amount: '10.01', submissionId: sid() }), /more than the plan cost/i, 'cannot refund more than the plan cost');
    await assert.rejects(() => operatorRefund.record({ ...base, subscriptionId: manualSub.id, amount: '10.00', submissionId: sid() }), /current plans/i, 'another customer\'s plan must be refused');
    const stripeSub = await fixtureSubscription({ query }, { customerId: owner.id, planId: plan.id, source: 'stripe', billingMode: 'subscription', providerSubscriptionId: unique('sub_stripe') });
    await assert.rejects(() => operatorRefund.record({ ...base, subscriptionId: stripeSub.id, amount: '4.00', submissionId: sid() }), /recorded automatically/i, 'Stripe refunds arrive by webhook and must not be recorded twice');
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0].status, 'active', 'refused requests change nothing');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE entity_id=ANY($1::text[]) AND action='billing.refund.recorded_externally'`, [[providerSub.id, stripeSub.id, manualSub.id]])).rows[0].n, 0, 'refused requests are not audited as recorded');

    // Partial refund: recorded once, plan untouched. Resubmitting the same form is a duplicate.
    const partialId = sid();
    const partial = await operatorRefund.record({ ...base, amount: '4.00', full: false, submissionId: partialId, actorUserId: null });
    assert.strictEqual(partial.ended, false);
    await assert.rejects(() => operatorRefund.record({ ...base, amount: '4.00', full: false, submissionId: partialId }), /already recorded/i, 'the same submission must record once');
    const [concurrentA, concurrentB] = await Promise.allSettled([1, 2].map(() => operatorRefund.record({ ...base, amount: '1.00', submissionId: '11111111-1111-4111-8111-111111111111' })));
    assert.strictEqual([concurrentA, concurrentB].filter(r => r.status === 'fulfilled').length, 1, 'two simultaneous submissions of one form record exactly once');
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0].status, 'active', 'a partial refund leaves the plan running');
    const ledger = (await query(`SELECT gross_amount_minor,transaction_type,metadata FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1`, [partial.eventId])).rows[0];
    assert.strictEqual(Number(ledger.gross_amount_minor), -400, 'the refund is a negative ledger entry');
    assert.strictEqual(ledger.transaction_type, 'refund');
    assert.strictEqual(ledger.metadata.operatorAttested, true, 'it is marked as operator-recorded');
    assert.strictEqual(historyKind({ provider: 'plisio', transaction_type: ledger.transaction_type, transaction_status: 'succeeded', gross_amount_minor: ledger.gross_amount_minor }), 'refund', 'the canonical classifier counts it as a Plisio refund');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_incidents WHERE provider_event_id=$1 AND incident_type='refund'`, [partial.eventId])).rows[0].n, 1, 'a refund incident is recorded');
    await assert.rejects(() => operatorRefund.record({ ...base, amount: '5.50', submissionId: sid() }), /more than the plan cost/i, 'the cap is cumulative across refunds');

    // Full refund of a Plisio-backed plan: the plan ends.
    const full = await operatorRefund.record({ ...base, amount: '5.00', full: true, submissionId: sid(), actorUserId: null });
    assert.strictEqual(full.ended, true);
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0].status, 'cancelled', 'a full refund ends the plan');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE entity_id=$1 AND action='billing.refund.recorded_externally_completed'`, [providerSub.id])).rows[0].n >= 1, true, 'completion is audited');

    // Two administrators refunding the SAME plan at once with different submission ids: the cumulative
    // cap is enforced under a subscription lock, so the total can never exceed what the plan cost.
    const raceCustomer = await fixtureCustomer({ query }, { displayName: 'Refund Race', email: `${unique('refund-race')}@example.invalid` });
    created.customers.push(raceCustomer.id);
    const raceSub = await fixtureSubscription({ query }, { customerId: raceCustomer.id, planId: plan.id, source: 'plisio', billingMode: 'payment', providerSubscriptionId: unique('plisio-race') });
    const raceBase = { customerId: raceCustomer.id, subscriptionId: raceSub.id, reason: 'Refunded in the Plisio dashboard after a duplicate payment' };
    const race = await Promise.allSettled([sid(), sid()].map(id => operatorRefund.record({ ...raceBase, amount: '7.00', submissionId: id })));
    assert.strictEqual(race.filter(r => r.status === 'fulfilled').length, 1, 'two concurrent 7.00 refunds against a 10.00 plan: exactly one is recorded');
    assert(race.find(r => r.status === 'rejected').reason.message.match(/more than the plan cost/i), 'the other is refused by the cap');
    const raceTotal = Number((await query(`SELECT COALESCE(SUM(-gross_amount_minor),0) n FROM payment_history_transactions WHERE customer_id=$1`, [raceCustomer.id])).rows[0].n);
    assert.strictEqual(raceTotal, 700, 'the ledger shows 7.00 refunded, never 14.00');

    // A failure part-way through is not final: the attempt is marked failed (and stops counting toward
    // the cap), and submitting the same amount and reason finishes it without repeating anything.
    const retryCustomer = await fixtureCustomer({ query }, { displayName: 'Refund Retry', email: `${unique('refund-retry')}@example.invalid` });
    created.customers.push(retryCustomer.id);
    const retrySub = await fixtureSubscription({ query }, { customerId: retryCustomer.id, planId: plan.id, source: 'plisio', billingMode: 'payment', providerSubscriptionId: unique('plisio-retry') });
    const retryBase = { customerId: retryCustomer.id, subscriptionId: retrySub.id, reason: 'Refunded in the Plisio dashboard after a duplicate payment', amount: '9.00' };
    const realRecord = financialState.recordTransaction, realReferral = referrals.revisitRewardAfterAdversePayment;
    try {
      financialState.recordTransaction = async () => { throw new Error('simulated ledger failure'); };
      await assert.rejects(() => operatorRefund.record({ ...retryBase, submissionId: sid() }), /only partly recorded/i, 'a ledger failure is reported as partial');
      financialState.recordTransaction = realRecord;
      referrals.revisitRewardAfterAdversePayment = async () => { throw new Error('simulated referral failure'); };
      await assert.rejects(() => operatorRefund.record({ ...retryBase, submissionId: sid() }), /only partly recorded/i, 'a referral failure is NOT swallowed');
    } finally { financialState.recordTransaction = realRecord; referrals.revisitRewardAfterAdversePayment = realReferral; }
    const finished = await operatorRefund.record({ ...retryBase, submissionId: sid() });
    assert.strictEqual(finished.resumed, true, 'the same amount and reason resumes the failed attempt');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_history_transactions WHERE customer_id=$1`, [retryCustomer.id])).rows[0].n, 1, 'one ledger entry after the retries');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_incidents WHERE customer_id=$1 AND incident_type='refund'`, [retryCustomer.id])).rows[0].n, 1, 'one refund incident after the retries');
    await assert.rejects(() => operatorRefund.record({ ...retryBase, amount: '2.00', submissionId: sid() }), /more than the plan cost/i, 'failed attempts do not count, but the completed 9.00 does');

    // Only the two supported shapes are accepted.
    const odd = await fixtureSubscription({ query }, { customerId: raceCustomer.id, planId: plan.id, source: 'admin_grant', billingMode: 'manual', providerSubscriptionId: unique('some-provider-ref') });
    await assert.rejects(() => operatorRefund.record({ customerId: raceCustomer.id, subscriptionId: odd.id, amount: '1.00', reason: 'Odd source with a provider reference', submissionId: sid() }), /reports its own refunds/i, 'a plan with a foreign provider reference is refused');

    // A plan with no provider reference (cash): ended, audited, and NOT attributed to any provider's ledger.
    const manual = await operatorRefund.record({ customerId: other.id, subscriptionId: manualSub.id, amount: '10.00', full: true, reason: 'Cash refunded at the counter', submissionId: sid(), actorUserId: null });
    assert.strictEqual(manual.ended, true);
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [manualSub.id])).rows[0].status, 'cancelled', 'a manual plan is ended by a full refund too');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_history_transactions WHERE customer_id=$1`, [other.id])).rows[0].n, 0, 'a cash refund must not appear as a provider transaction');
}

async function cleanup() {
    await query(`DELETE FROM payment_history_transactions WHERE customer_id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
    await query(`DELETE FROM payment_incidents WHERE customer_id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
    await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
    await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [created.plans]).catch(() => {});
    await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [created.customers]).catch(() => {});
}

main()
    .then(() => console.log('operator refund DB smoke: ok'))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
    .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
