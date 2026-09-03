'use strict';

const { query, transaction } = require('../db');

const RETRY_MINUTES = Object.freeze([1, 5, 15, 60, 180, 360]);
const CLAIM_LEASE_MINUTES = 15;

function cleanError(error) {
    return String(error?.message || error || 'Automatic Free downgrade failed')
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 1000) || 'Automatic Free downgrade failed';
}

function retryMinutes(attemptCount) {
    const attempt = Math.max(1, Number(attemptCount) || 1);
    return RETRY_MINUTES[Math.min(attempt - 1, RETRY_MINUTES.length - 1)];
}

async function enqueue(customerId, error) {
    const message = cleanError(error);
    const result = await query(`
        INSERT INTO automatic_free_downgrade_retries(
            customer_id,attempt_count,next_attempt_at,last_error,created_at,updated_at
        ) VALUES($1,0,NOW(),$2,NOW(),NOW())
        ON CONFLICT(customer_id) DO UPDATE SET
            next_attempt_at=LEAST(automatic_free_downgrade_retries.next_attempt_at,NOW()),
            last_error=EXCLUDED.last_error,
            updated_at=NOW()
        RETURNING *
    `, [customerId, message]);
    return result.rows[0];
}

async function claimDue({ limit = 25 } = {}) {
    const bounded = Math.max(1, Math.min(250, Number(limit) || 25));
    return transaction(async client => {
        const result = await client.query(`
            WITH due AS (
                SELECT customer_id
                FROM automatic_free_downgrade_retries
                WHERE next_attempt_at<=NOW()
                ORDER BY next_attempt_at,created_at,customer_id
                FOR UPDATE SKIP LOCKED
                LIMIT $1
            )
            UPDATE automatic_free_downgrade_retries r
            SET attempt_count=r.attempt_count+1,
                last_attempt_at=NOW(),
                next_attempt_at=NOW()+make_interval(mins=>$2),
                updated_at=NOW()
            FROM due
            WHERE r.customer_id=due.customer_id
            RETURNING r.*
        `, [bounded, CLAIM_LEASE_MINUTES]);
        return result.rows;
    });
}

async function complete(row, outcome) {
    return transaction(async client => {
        const removed = await client.query(`
            DELETE FROM automatic_free_downgrade_retries
            WHERE customer_id=$1 AND attempt_count=$2
            RETURNING customer_id
        `, [row.customer_id, row.attempt_count]);
        if (!removed.rowCount) return false;
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('subscription.free.auto_downgrade.retry_resolved','customer',$1,$2::jsonb)
        `, [row.customer_id, JSON.stringify({
            attempts: row.attempt_count,
            outcome: outcome || 'resolved'
        })]);
        return true;
    });
}

async function fail(row, error) {
    const minutes = retryMinutes(row.attempt_count);
    const result = await query(`
        UPDATE automatic_free_downgrade_retries
        SET last_error=$3,
            next_attempt_at=NOW()+make_interval(mins=>$4),
            updated_at=NOW()
        WHERE customer_id=$1 AND attempt_count=$2
        RETURNING *
    `, [row.customer_id, row.attempt_count, cleanError(error), minutes]);
    return result.rows[0] || null;
}

async function processDue({ limit = 25, attempt = null } = {}) {
    const execute = typeof attempt === 'function'
        ? attempt
        : customerId => require('../payments/lifecycle').autoDowngradeEligibleCustomer(customerId);
    const rows = await claimDue({ limit });
    const summary = { total: rows.length, succeeded: 0, resolved: 0, failed: 0 };
    const failureReasons = new Map();

    for (const row of rows) {
        try {
            const result = await execute(row.customer_id, row);
            const outcome = result ? 'downgraded' : 'no_longer_applicable';
            const completed = await complete(row, outcome);
            if (!completed) continue;
            if (result) summary.succeeded += 1;
            else summary.resolved += 1;
        } catch (error) {
            await fail(row, error);
            summary.failed += 1;
            const reason = cleanError(error).slice(0, 300);
            failureReasons.set(reason, Number(failureReasons.get(reason) || 0) + 1);
        }
    }

    if (summary.failed) {
        const top = [...failureReasons.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 2)
            .map(([message, count]) => `${count}× ${message}`)
            .join('; ');
        summary.warning = `${summary.failed} automatic Free downgrade retr${summary.failed === 1 ? 'y' : 'ies'} failed${top ? `: ${top}` : ''}`.slice(0, 1000);
    }
    return summary;
}

async function pendingCount() {
    const result = await query('SELECT COUNT(*)::int AS count FROM automatic_free_downgrade_retries');
    return Number(result.rows[0]?.count || 0);
}

module.exports = {
    RETRY_MINUTES,
    CLAIM_LEASE_MINUTES,
    cleanError,
    retryMinutes,
    enqueue,
    claimDue,
    complete,
    fail,
    processDue,
    pendingCount
};
