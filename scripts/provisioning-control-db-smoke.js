'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const provisioning = require('../src/jellyfin/resilient-provisioning');
const jobs = require('../src/jellyfin/jobs');

(async () => {
    const suffix = crypto.randomBytes(5).toString('hex');
    let userId = null;
    let customerId = null;
    let planId = null;

    try {
        const user = await query(`
            INSERT INTO app_users(username,password_hash,role,active,email_verified_at)
            VALUES($1,'test-hash','customer',TRUE,NOW()) RETURNING id
        `, [`prov_${suffix}`]);
        userId = user.rows[0].id;

        const customer = await query(`
            INSERT INTO customers(user_id,display_name)
            VALUES($1,$2) RETURNING id
        `, [userId, `Provisioning ${suffix}`]);
        customerId = customer.rows[0].id;

        const plan = await query(`
            INSERT INTO plans(
                code,name,audience,billing_interval,duration_days,price_minor,currency,streams,
                allow_downloads,allow_video_transcoding,server_class,active,visible
            ) VALUES($1,$2,'direct','custom',30,0,'USD',1,FALSE,FALSE,'custom',TRUE,TRUE)
            RETURNING id
        `, [`prov-${suffix}`, `Provisioning ${suffix}`]);
        planId = plan.rows[0].id;

        await query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')
        `, [customerId, planId]);

        let blocked = false;
        try {
            await provisioning.reconcileCustomer(customerId);
        } catch (error) {
            blocked = /no eligible jellyfin server/i.test(error.message);
        }
        assert(blocked, 'zero-server provisioning should report that no eligible server is available');

        const state = await provisioning.control.getCustomerState(customerId);
        assert(state, 'customer provisioning state should be persisted');
        assert.strictEqual(state.status, 'blocked', 'zero-server configuration should be blocked, not an unclassified failure');
        assert.strictEqual(Number(state.attempt_count), 1, 'attempt count should record the reconcile attempt');
        assert(state.last_error && /no eligible jellyfin server/i.test(state.last_error));
        assert(new Date(state.next_attempt_at).getTime() > Date.now(), 'blocked state should have a future retry time');

        const run = await query(`
            SELECT status,action,detail FROM provisioning_runs
            WHERE customer_id=$1 ORDER BY started_at DESC LIMIT 1
        `, [customerId]);
        assert.strictEqual(run.rows[0].status, 'failed');
        assert.strictEqual(run.rows[0].action, 'reconcile');

        await provisioning.control.forceCustomerDue(customerId);
        const forced = await provisioning.control.getCustomerState(customerId);
        assert.strictEqual(forced.status, 'pending');
        assert(new Date(forced.next_attempt_at).getTime() <= Date.now() + 1000);

        const due = await jobs.dueActiveCustomers(100);
        assert(due.some(row => row.customer_id === customerId), 'manually queued customer should be visible to the due scheduler');

        console.log('provisioning control db smoke: ok');
    } finally {
        if (customerId) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        if (planId) await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
        if (userId) await query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
