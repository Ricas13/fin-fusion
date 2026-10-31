'use strict';

// A refund made outside the app (provider dashboard or cash) can be recorded by an administrator.
// A full refund ends the plan like a provider refund; a partial refund only records the money.
// Everything needs a reason and is audited, and a plan belonging to another customer is refused.

require('dotenv').config();
const assert = require('assert');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('operator refund DB smoke')) process.exit(0);

const { query, getPool } = require('../src/db');
const operatorRefund = require('../src/payments/operator-refund');
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

    // Guards.
    await assert.rejects(() => operatorRefund.record({ customerId: owner.id, subscriptionId: providerSub.id, amount: '10.00', reason: 'short' }), /reason/i);
    await assert.rejects(() => operatorRefund.record({ customerId: owner.id, subscriptionId: providerSub.id, amount: '0', reason }), /amount/i);
    await assert.rejects(() => operatorRefund.record({ customerId: owner.id, subscriptionId: providerSub.id, amount: '99999', reason }), /far above/i);
    await assert.rejects(() => operatorRefund.record({ customerId: owner.id, subscriptionId: manualSub.id, amount: '10.00', reason }), /current plans/i, 'another customer\'s plan must be refused');
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0].status, 'active', 'refused requests change nothing');

    // Partial refund: recorded, plan untouched.
    const partial = await operatorRefund.record({ customerId: owner.id, subscriptionId: providerSub.id, amount: '4.00', full: false, reason, actorUserId: null });
    assert.strictEqual(partial.ended, false);
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0].status, 'active', 'a partial refund leaves the plan running');
    const ledger = (await query(`SELECT gross_amount_minor,transaction_type,metadata FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1`, [partial.eventId])).rows[0];
    assert.strictEqual(Number(ledger.gross_amount_minor), -400, 'the refund is a negative ledger entry');
    assert.strictEqual(ledger.transaction_type, 'refund');
    assert.strictEqual(ledger.metadata.operatorAttested, true, 'it is marked as operator-recorded');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_incidents WHERE provider_event_id=$1 AND incident_type='refund'`, [partial.eventId])).rows[0].n, 1, 'a refund incident is recorded');

    // Full refund of a provider-backed plan: the plan ends.
    const full = await operatorRefund.record({ customerId: owner.id, subscriptionId: providerSub.id, amount: '10.00', full: true, reason, actorUserId: null });
    assert.strictEqual(full.ended, true);
    const ended = (await query('SELECT status,cancel_at_period_end FROM subscriptions WHERE id=$1', [providerSub.id])).rows[0];
    assert.strictEqual(ended.status, 'cancelled', 'a full refund ends the plan');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE entity_id=$1 AND action='billing.refund.recorded_externally'`, [providerSub.id])).rows[0].n, 2, 'both refunds are audited');

    // Full refund of a plan with no provider reference still ends it (no incident possible).
    const manual = await operatorRefund.record({ customerId: other.id, subscriptionId: manualSub.id, amount: '10.00', full: true, reason: 'Cash refunded at the counter', actorUserId: null });
    assert.strictEqual(manual.ended, true);
    assert.strictEqual((await query('SELECT status FROM subscriptions WHERE id=$1', [manualSub.id])).rows[0].status, 'cancelled', 'a manual plan is ended by a full refund too');
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
