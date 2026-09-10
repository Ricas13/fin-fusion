'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const notifications = require('../integrations/notification-dispatch');

const ALERT_BUCKET_MS = 6 * 60 * 60 * 1000;

function clean(value, max = 500) {
    return String(value == null ? '' : value)
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, max);
}

function finding(kind, row, detail) {
    return {
        kind,
        id: String(row.id || row.customer_id || row.subscription_id || 'unknown'),
        customerId: row.customer_id || row.owner_id || null,
        detail: clean(detail, 900)
    };
}

async function scan() {
    const findings = [];
    const [permanentRefunds, manualProviderOps, deletionFailures, staleCreationIntents, contaminatedPlans, strandedProvisioning, stalePaymentEvents] = await Promise.all([
        query(`
            SELECT o.customer_id,o.subscription_id,s.source,s.provider_subscription_id
            FROM customer_entitlement_overrides o
            JOIN subscriptions s ON s.id=o.subscription_id
            WHERE o.permanent_access=TRUE AND o.revoked_at IS NULL
              AND s.refund_terminated_at IS NOT NULL
            ORDER BY o.updated_at
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT id,provider,operation_type,owner_id,last_error,updated_at
            FROM provider_operations
            WHERE manual_review_required=TRUE
            ORDER BY updated_at
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT id,customer_id,status,attempt_count,last_error,updated_at,next_attempt_at
            FROM customer_deletion_jobs
            WHERE status='failed'
               OR (status='running' AND updated_at<NOW()-INTERVAL '20 minutes')
            ORDER BY updated_at
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT id,customer_id,server_id,username,status,remote_user_id,last_error,updated_at
            FROM jellyfin_account_creation_intents
            WHERE updated_at<NOW()-INTERVAL '45 minutes'
            ORDER BY updated_at
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT id,code,name,server_class,is_free_tier,price_minor,billing_interval
            FROM plans
            WHERE server_class='free' AND COALESCE(is_free_tier,FALSE)=FALSE
            ORDER BY updated_at DESC
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT customer_id,status,consecutive_failures,last_error,last_attempt_at,next_attempt_at,updated_at
            FROM customer_provisioning_state
            WHERE status IN('failed','blocked')
              AND (
                consecutive_failures>=2
                OR COALESCE(last_attempt_at,updated_at)<NOW()-INTERVAL '10 minutes'
              )
            ORDER BY COALESCE(last_attempt_at,updated_at)
            LIMIT 100
        `).catch(() => ({ rows: [] })),
        query(`
            SELECT id,provider,provider_event_id,event_type,processing_error,processing_started_at,created_at
            FROM payment_events
            WHERE provider IN('stripe','paypal','plisio')
              AND processed_at IS NULL
              AND created_at<NOW()-INTERVAL '45 minutes'
            ORDER BY created_at
            LIMIT 100
        `).catch(() => ({ rows: [] }))
    ]);

    for (const row of permanentRefunds.rows) findings.push(finding('refunded_permanent_access', row, `Refund-terminated subscription ${row.subscription_id} still has Permanent Access.`));
    for (const row of manualProviderOps.rows) findings.push(finding('provider_manual_review', row, `${row.provider} ${row.operation_type} requires manual review${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of deletionFailures.rows) findings.push(finding('customer_deletion_stuck', row, `Customer deletion ${row.id} is ${row.status} after ${row.attempt_count || 0} attempt(s)${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of staleCreationIntents.rows) findings.push(finding('jellyfin_creation_intent_stale', row, `Jellyfin creation intent ${row.id} remains ${row.status} on server ${row.server_id}${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of contaminatedPlans.rows) findings.push(finding('paid_plan_on_free_pool', row, `Plan ${row.code || row.name || row.id} is not a Free plan but uses server_class=free.`));
    for (const row of strandedProvisioning.rows) findings.push(finding('customer_access_not_converged', row, `Customer access is ${row.status} after ${row.consecutive_failures || 0} failure(s)${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of stalePaymentEvents.rows) findings.push(finding('payment_event_stale', row, `${row.provider} ${row.event_type || 'payment event'} ${row.provider_event_id} has remained unprocessed${row.processing_error ? `: ${row.processing_error}` : ''}`));

    return findings;
}

function fingerprint(findings) {
    return crypto.createHash('sha256')
        .update(findings.map(item => `${item.kind}:${item.id}`).sort().join('|'))
        .digest('hex')
        .slice(0, 24);
}

async function notify(findings) {
    if (!findings.length) return null;
    const bucket = Math.floor(Date.now() / ALERT_BUCKET_MS);
    const top = findings.slice(0, 8).map(item => `• ${item.kind}: ${item.detail}`).join('\n');
    const extra = findings.length > 8 ? `\n• +${findings.length - 8} more integrity failure(s)` : '';
    return notifications.dispatch({
        eventType: 'automation.integrity.failed',
        subject: 'CAPTaINFiN customer/revenue integrity failure',
        text: `${findings.length} customer/revenue integrity condition${findings.length === 1 ? '' : 's'} require attention.\n\n${top}${extra}`,
        adminSubject: `URGENT: ${findings.length} CAPTaINFiN integrity failure${findings.length === 1 ? '' : 's'}`,
        adminText: `${findings.length} customer/revenue integrity condition${findings.length === 1 ? '' : 's'} require attention.\n\n${top}${extra}`,
        dedupeKey: `automation-integrity:${fingerprint(findings)}:${bucket}`,
        templatePayload: { count: findings.length, findings: findings.slice(0, 12) }
    });
}

async function run() {
    const findings = await scan();
    let notification = null;
    if (findings.length) {
        try { notification = await notify(findings); }
        catch (error) { notification = { errors: [clean(error, 900)] }; }
    }
    const warning = findings.length
        ? `${findings.length} customer/revenue integrity failure${findings.length === 1 ? '' : 's'}: ${findings.slice(0, 5).map(item => `${item.kind} (${item.detail})`).join('; ')}`.slice(0, 1000)
        : null;
    return {
        total: findings.length,
        processed: findings.length,
        failed: findings.length,
        findings,
        notification,
        ...(warning ? { warning } : {})
    };
}

module.exports = { ALERT_BUCKET_MS, clean, finding, scan, fingerprint, notify, run };
