'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const retry = require('../src/entitlements/automatic-free-downgrade-retry');
const expiry = require('../src/entitlements/subscription-expiry');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [] };

async function customer(label) {
    const row = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Auto downgrade ${label} ${suffix}`, `auto-downgrade-${label}-${suffix}@example.invalid`]
    );
    created.customers.push(row.rows[0].id);
    return row.rows[0].id;
}

async function paidPlan() {
    const row = await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,
            price_minor,currency,capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1000,TRUE,TRUE,1,'premium')
        RETURNING id
    `, [`auto-downgrade-${suffix}`, `Auto downgrade paid ${suffix}`]);
    created.plans.push(row.rows[0].id);
    return row.rows[0].id;
}

async function queued(customerId) {
    const result = await query('SELECT * FROM automatic_free_downgrade_retries WHERE customer_id=$1', [customerId]);
    return result.rows[0] || null;
}

(async () => {
    try {
        const first = await customer('retry');
        await retry.enqueue(first, new Error('temporary downgrade failure\nfrom test'));
        let row = await queued(first);
        assert(row, 'failed downgrade must create a durable retry row');
        assert.strictEqual(Number(row.attempt_count), 0, 'initial durable marker is not yet a retry attempt');
        assert.match(row.last_error, /temporary downgrade failure from test/, 'stored retry error must be compact and operator-readable');

        const failed = await retry.processDue({
            limit: 10,
            attempt: async customerId => {
                assert.strictEqual(String(customerId), String(first));
                throw new Error('Free provisioning still unavailable');
            }
        });
        assert.strictEqual(failed.total, 1);
        assert.strictEqual(failed.failed, 1, 'failed retry must contribute to automation failure state');
        assert.match(failed.warning, /automatic Free downgrade retry failed/, 'failed retry must expose an automation warning');
        row = await queued(first);
        assert.strictEqual(Number(row.attempt_count), 1, 'retry attempts must be durable');
        assert(new Date(row.next_attempt_at).getTime() > Date.now(), 'failed retry must back off instead of hot-looping');
        assert.match(row.last_error, /still unavailable/, 'latest retry failure must be retained');

        await query('UPDATE automatic_free_downgrade_retries SET next_attempt_at=NOW() WHERE customer_id=$1', [first]);
        const succeeded = await retry.processDue({
            limit: 10,
            attempt: async () => ({ id: `free-${suffix}` })
        });
        assert.strictEqual(succeeded.succeeded, 1, 'successful retry must record a completed downgrade');
        assert.strictEqual(await queued(first), null, 'successful retry must remove the durable pending marker');
        const audit = await query(`
            SELECT metadata FROM audit_log
            WHERE action='subscription.free.auto_downgrade.retry_resolved'
              AND entity_type='customer' AND entity_id=$1
            ORDER BY created_at DESC,id DESC LIMIT 1
        `, [first]);
        assert.strictEqual(audit.rowCount, 1, 'resolved retry must be auditable');
        assert.strictEqual(audit.rows[0].metadata.outcome, 'downgraded');

        const noLongerApplicable = await customer('resolved');
        await retry.enqueue(noLongerApplicable, new Error('earlier transient failure'));
        const resolved = await retry.processDue({ limit: 10, attempt: async () => null });
        assert.strictEqual(resolved.resolved, 1, 'a retry that is no longer applicable must close rather than loop forever');
        assert.strictEqual(await queued(noLongerApplicable), null);

        const expiryCustomer = await customer('expiry');
        const planId = await paidPlan();
        const subscription = await query(`
            INSERT INTO subscriptions(
                customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,service_type_snapshot
            ) VALUES($1,$2,'active','admin_grant','manual',NOW()-INTERVAL '60 days',NOW()-INTERVAL '1 minute','jellyfin')
            RETURNING id
        `, [expiryCustomer, planId]);
        const reconciled = [];
        const expiryResult = await expiry.expireAndReconcile({
            reconcileCustomer: async customerId => { reconciled.push(String(customerId)); return { active: false }; },
            autoDowngrade: async customerId => {
                if (String(customerId) === String(expiryCustomer)) throw new Error('simulated automatic downgrade database outage');
                return null;
            },
            syncRecurring: async () => ({ ok: true }),
            detail: true
        });
        const expiredSubscription = await query('SELECT status FROM subscriptions WHERE id=$1', [subscription.rows[0].id]);
        assert.strictEqual(expiredSubscription.rows[0].status, 'expired', 'paid commercial expiry must remain committed even when Free downgrade fails');
        assert(reconciled.includes(String(expiryCustomer)), 'normal reconciliation must still run so expired paid access is closed while downgrade waits');
        assert(expiryResult.failed >= 1, 'failed automatic downgrade must make the entitlement automation outcome degraded');
        const expiryRetry = await queued(expiryCustomer);
        assert(expiryRetry, 'automatic downgrade exception after paid expiry must be durably queued for a future cycle');
        assert.match(expiryRetry.last_error, /simulated automatic downgrade database outage/);

        console.log('automatic Free downgrade retry DB smoke: ok');
    } finally {
        for (const customerId of created.customers.reverse()) {
            await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        }
        for (const planId of created.plans.reverse()) {
            await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
        }
    }
})().finally(() => getPool().end()).catch(() => {
    console.error('automatic Free downgrade retry DB smoke failed');
    process.exit(1);
});
