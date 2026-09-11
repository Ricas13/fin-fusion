'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('Notification lifecycle durable retry smoke')) process.exit(0);

const { query, getPool } = require('../src/db');
const dispatch = require('../src/integrations/notification-dispatch');
const lifecycle = require('../src/automation/notification-lifecycle');
const jobs = require('../src/automation/jobs');
const jobHealth = require('../src/automation/job-health');
const policy = require('../src/platform/actionable-attention-policy');

async function main() {
    const originalDispatch = dispatch.dispatch;
    const originalState = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [lifecycle.STATE_KEY]);
    const customerId = crypto.randomUUID();
    let auditId = null;
    let dedupeKey = null;
    try {
        const start = new Date(Date.now() - 5 * 60 * 1000);
        await query(`
            INSERT INTO platform_settings(setting_key,setting_value)
            VALUES($1,$2::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
        `, [lifecycle.STATE_KEY, JSON.stringify({ cursor: start.toISOString(), servers: {} })]);

        const event = (await query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata,created_at)
            VALUES('customer.plan_change.immediate','customer',$1,'{}'::jsonb,NOW()-INTERVAL '30 seconds')
            RETURNING id,created_at
        `, [customerId])).rows[0];
        auditId = event.id;
        dedupeKey = `plan-change-applied:immediate:${event.id}`;
        await query('DELETE FROM notification_lifecycle_retries WHERE dedupe_key=$1', [dedupeKey]);

        dispatch.dispatch = async input => input.dedupeKey === dedupeKey
            ? { email: false, telegram: false, discord: false, errors: ['forced downstream delivery failure'] }
            : { email: false, telegram: false, discord: false, errors: [] };

        const first = await jobs.notificationLifecycleSafeRun();
        assert.strictEqual(Number(first.failed || 0), 0, 'durably queued delivery failures must not back off discovery automation');
        assert.strictEqual(Number(first.deliveryFailed || 0), 1, 'the job wrapper must retain delivery failure telemetry');
        assert(Number(first.retryQueued || 0) >= 1, 'failed lifecycle delivery was not placed on durable retry');

        const queued = (await query(`
            SELECT dedupe_key,event_type,payload,attempts,next_attempt_at,last_error,created_at
            FROM notification_lifecycle_retries WHERE dedupe_key=$1
        `, [dedupeKey])).rows[0];
        assert(queued, 'durable lifecycle retry row was not created');
        assert.strictEqual(queued.event_type, 'customer.plan_change.applied');
        assert.strictEqual(queued.payload?.dedupeKey, dedupeKey);
        assert(/forced downstream delivery failure/.test(queued.last_error || ''));

        const stateAfterFailure = await lifecycle.loadState(new Date());
        assert(new Date(stateAfterFailure.cursor).getTime() > new Date(event.created_at).getTime(),
            'a durably captured delivery failure must not rewind the global discovery cursor');

        // Persistent retries stay operator-visible without poisoning the actual
        // scheduler state or delaying discovery of newer lifecycle events.
        await query(`
            UPDATE notification_lifecycle_retries
            SET attempts=3,created_at=NOW()-INTERVAL '2 hours',next_attempt_at=NOW()+INTERVAL '1 hour'
            WHERE dedupe_key=$1
        `, [dedupeKey]);
        await query(`
            INSERT INTO automation_job_state(job_key,enabled,interval_seconds,last_outcome,last_completed_at,last_success_at,consecutive_failures,updated_at)
            VALUES('notification_lifecycle',TRUE,300,'success',NOW(),NOW(),0,NOW())
            ON CONFLICT(job_key) DO UPDATE
            SET enabled=TRUE,last_outcome='success',last_error=NULL,last_warning=NULL,last_completed_at=NOW(),last_success_at=NOW(),consecutive_failures=0,updated_at=NOW()
        `);
        const healthRows = await jobHealth.list();
        const lifecycleHealth = healthRows.find(row => row.job_key === 'notification_lifecycle');
        assert(lifecycleHealth?.lifecycle_retry_backlog, 'persistent lifecycle retry backlog must decorate operator job health');
        assert.strictEqual(jobHealth.healthState(lifecycleHealth), 'degraded');
        assert(policy.jobDecision(lifecycleHealth, 'degraded').visible, 'persistent lifecycle retries must be visible in Needs Attention');

        await query('UPDATE notification_lifecycle_retries SET next_attempt_at=NOW() WHERE dedupe_key=$1', [dedupeKey]);
        dispatch.dispatch = async input => ({
            email: input.dedupeKey === dedupeKey,
            telegram: false,
            discord: false,
            errors: []
        });

        const second = await jobs.notificationLifecycleSafeRun();
        assert(Number(second.retryResolved || 0) >= 1, 'successful durable retry was not resolved');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM notification_lifecycle_retries WHERE dedupe_key=$1', [dedupeKey])).rows[0].n, 0,
            'resolved lifecycle retry row was not cleared');

        // The event itself must not be rediscovered after the cursor advanced;
        // the one dispatch above came from the durable retry queue.
        assert.strictEqual(Number(second.deliveryFailed || 0), 0);
        console.log('notification lifecycle durable retry smoke: ok');
    } finally {
        dispatch.dispatch = originalDispatch;
        if (dedupeKey) await query('DELETE FROM notification_lifecycle_retries WHERE dedupe_key=$1', [dedupeKey]).catch(() => {});
        if (auditId) await query('DELETE FROM audit_log WHERE id=$1', [auditId]).catch(() => {});
        if (originalState.rowCount) {
            await query(`
                INSERT INTO platform_settings(setting_key,setting_value)
                VALUES($1,$2::jsonb)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
            `, [lifecycle.STATE_KEY, JSON.stringify(originalState.rows[0].setting_value)]).catch(() => {});
        } else {
            await query('DELETE FROM platform_settings WHERE setting_key=$1', [lifecycle.STATE_KEY]).catch(() => {});
        }
    }
}

main().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
