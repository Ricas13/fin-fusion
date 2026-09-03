'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { getPool } = require('../src/db');
const operationalMetrics = require('../src/platform/operational-metrics');

async function main() {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const suffix = crypto.randomBytes(6).toString('hex');
        const old = new Date(Date.now() - 400 * 86400000);
        const cutoff = new Date(Date.now() - 30 * 86400000);

        // Batch size is a hard upper bound even when more eligible history exists.
        for (let index = 0; index < 3; index += 1) {
            await client.query(
                `INSERT INTO auth_events(identity_hint,event_type,success,metadata,created_at)
                 VALUES($1,'ci.retention',TRUE,'{}'::jsonb,$2)`,
                [`retention-${suffix}-${index}`, old]
            );
        }
        const bounded = await client.query("SELECT run_data_retention_batch('auth_events',$1,2) AS deleted", [cutoff]);
        assert.strictEqual(Number(bounded.rows[0].deleted), 2, 'retention batch must delete no more than the requested limit');
        const authRemaining = await client.query("SELECT COUNT(*)::int n FROM auth_events WHERE identity_hint LIKE $1", [`retention-${suffix}-%`]);
        assert.strictEqual(Number(authRemaining.rows[0].n), 1, 'bounded retention should leave the third eligible row for a later run');

        // Provider saga retention only accepts terminal reconciled/compensated operations.
        const owner = (await client.query(
            'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
            [`Retention ${suffix}`, `retention-${suffix}@example.invalid`]
        )).rows[0];
        const pendingKey = `ci-pending-${suffix}`;
        const failedKey = `ci-failed-${suffix}`;
        const terminalKey = `ci-terminal-${suffix}`;
        await client.query(
            `INSERT INTO provider_operations(provider,scope,owner_id,operation_type,idempotency_key,state,created_at,updated_at)
             VALUES
             ('stripe','subscription',$4,'ci.retention',$1,'provider_applied',$5,$5),
             ('paypal','subscription',$4,'ci.retention',$2,'failed',$5,$5),
             ('stripe','subscription',$4,'ci.retention',$3,'reconciled',$5,$5)`,
            [pendingKey, failedKey, terminalKey, owner.id, old]
        );
        const providerBatch = await client.query("SELECT run_data_retention_batch('provider_operations',$1,100) AS deleted", [cutoff]);
        assert(Number(providerBatch.rows[0].deleted) >= 1, 'terminal provider operation should be retention eligible');
        const providerStates = await client.query('SELECT idempotency_key,state FROM provider_operations WHERE idempotency_key=ANY($1::text[]) ORDER BY idempotency_key', [[pendingKey, failedKey, terminalKey]]);
        assert(providerStates.rows.some(row => row.idempotency_key === pendingKey && row.state === 'provider_applied'), 'unfinished provider_applied operation must never be retained away');
        assert(providerStates.rows.some(row => row.idempotency_key === failedKey && row.state === 'failed'), 'failed provider operation must remain available for reconciliation/manual action');
        assert(!providerStates.rows.some(row => row.idempotency_key === terminalKey), 'old reconciled provider operation should be eligible for deletion');

        // Payment processing errors and unfinished events are problem state, not disposable history.
        const pendingEvent = `ci-payment-pending-${suffix}`;
        const errorEvent = `ci-payment-error-${suffix}`;
        const doneEvent = `ci-payment-done-${suffix}`;
        await client.query(
            `INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,processing_error,created_at)
             VALUES
             ('stripe',$1,'ci.retention','{}'::jsonb,NULL,NULL,$4),
             ('stripe',$2,'ci.retention','{}'::jsonb,$4,'ci expected error',$4),
             ('stripe',$3,'ci.retention','{}'::jsonb,$4,NULL,$4)`,
            [pendingEvent, errorEvent, doneEvent, old]
        );
        await client.query("SELECT run_data_retention_batch('payment_events',$1,100)", [cutoff]);
        const paymentRows = await client.query('SELECT provider_event_id FROM payment_events WHERE provider_event_id=ANY($1::text[])', [[pendingEvent, errorEvent, doneEvent]]);
        assert(paymentRows.rows.some(row => row.provider_event_id === pendingEvent), 'unprocessed payment event must be preserved');
        assert(paymentRows.rows.some(row => row.provider_event_id === errorEvent), 'payment event with processing_error must be preserved');
        assert(!paymentRows.rows.some(row => row.provider_event_id === doneEvent), 'successfully processed old payment event should be eligible for deletion');

        // Expired household/network leases have a scheduled, bounded canonical cleanup owner.
        const networkHash = crypto.createHash('sha256').update(`lease-${suffix}`).digest('hex');
        await client.query(
            `INSERT INTO access_network_leases(tenant_key,scope,subject_key,network_hash,expires_at)
             VALUES('default','ci',$1,$2,NOW()-INTERVAL '1 hour')`,
            [`retention-${suffix}`, networkHash]
        );
        const leases = await client.query('SELECT cleanup_expired_access_network_leases(1) AS deleted');
        assert.strictEqual(Number(leases.rows[0].deleted), 1, 'expired network lease cleanup should remove an expired lease');
        const leaseRemaining = await client.query('SELECT 1 FROM access_network_leases WHERE subject_key=$1', [`retention-${suffix}`]);
        assert.strictEqual(leaseRemaining.rowCount, 0, 'expired network lease must not survive canonical cleanup');

        const audit = await client.query("SELECT 1 FROM audit_log WHERE action='data.retention.batch' AND entity_type='data_retention' LIMIT 1");
        assert(audit.rowCount === 1, 'retention runs must be auditable');

        // Operator observability SQL must compile against the production schema and
        // return only aggregate counters. The fixture writes above are intentionally
        // uncommitted; this second pooled connection validates the durable schema
        // contract without depending on fixture visibility.
        const backlog = await operationalMetrics.backlogSnapshot();
        assert.strictEqual(backlog.available, true, 'operational backlog snapshot must compile against the migrated database');
        for (const key of ['paymentEventRetries','providerRecovery','providerManualReview','freeDowngradeRetries','freeDowngradeDue','provisioningProblems','provisioningRunning']) {
            assert(Number.isFinite(backlog[key]) && backlog[key] >= 0, `${key} must be a non-negative aggregate counter`);
        }
        const support = operationalMetrics.supportSnapshot({ databasePool: operationalMetrics.poolSnapshot(), reconciliation: {}, backlog });
        assert(Number.isFinite(support.databasePool.total) && Number.isFinite(support.databasePool.max), 'live pg pool counters must be numeric');
        assert.strictEqual(support.backlog.available, true);

        await client.query('ROLLBACK');
        console.log('Database operational hardening DB smoke: OK');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
        await getPool().end();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
