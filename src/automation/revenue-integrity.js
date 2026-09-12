'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const notifications = require('../integrations/notification-dispatch');

const ALERT_BUCKET_MS = 6 * 60 * 60 * 1000;
const ADMIN_ACTOR_ENFORCED_AT = '2026-09-12T08:32:17.000Z';
const LEGACY_ACTORLESS_ADMIN_REPAIR = '20260912113000';

const ACTORLESS_ADMIN_HOLDS_SQL = `
    SELECT h.id,h.customer_id,h.hold_type,h.source_key,h.reason,h.created_at
    FROM customer_access_holds h
    WHERE h.released_at IS NULL
      AND h.actor_user_id IS NULL
      AND h.source_key='admin'
      AND h.hold_type IN('admin_disabled','admin_suspended','admin_hold')
      AND NOT (
        h.created_at < $1::timestamptz
        AND COALESCE(jsonb_typeof(h.metadata),'')='object'
        AND h.metadata @> jsonb_build_object(
          'legacyActorlessAdmin', TRUE,
          'legacyActorRepair', $2::text
        )
        AND NULLIF(h.metadata->>'legacyActorMarkedAt','') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM audit_log a
          WHERE a.action='customer.access_hold.legacy_actorless_marked'
            AND a.entity_type='customer'
            AND a.entity_id=h.customer_id::text
            AND a.metadata->>'holdId'=h.id::text
            AND a.metadata->>'repair'=$2::text
            AND COALESCE((a.metadata->>'preservedBlockingState')::boolean,FALSE)=TRUE
            AND COALESCE((a.metadata->>'preservedAuthorityIdentity')::boolean,FALSE)=TRUE
        )
      )
    ORDER BY h.created_at
    LIMIT 100
`;

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

async function retireObsoleteManualRenewalOperations({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await query(`
        WITH candidates AS (
            SELECT po.id
            FROM provider_operations po
            JOIN subscriptions s
              ON s.id::text = COALESCE(
                  NULLIF(po.request_snapshot->>'subscriptionId',''),
                  NULLIF(po.local_reference,'')
              )
            WHERE po.manual_review_required=TRUE
              AND po.state='failed'
              AND po.failure_kind='terminal'
              AND po.operation_type IN('renewal_stop','renewal_resume')
              AND po.provider IN('stripe','paypal')
              AND (
                  COALESCE(s.billing_mode,'')<>'subscription'
                  OR COALESCE(s.source,'')<>po.provider
                  OR NULLIF(s.provider_subscription_id,'') IS NULL
                  OR (
                      NULLIF(po.request_snapshot->>'providerSubscriptionId','') IS NOT NULL
                      AND s.provider_subscription_id IS DISTINCT FROM po.request_snapshot->>'providerSubscriptionId'
                  )
              )
            ORDER BY po.updated_at
            LIMIT $1
            FOR UPDATE OF po SKIP LOCKED
        )
        UPDATE provider_operations po
           SET failure_kind='superseded',
               manual_review_required=FALSE,
               next_attempt_at=NULL,
               provider_result=COALESCE(po.provider_result,'{}'::jsonb)
                   || '{"autoSuperseded":"renewal_target_no_longer_current"}'::jsonb,
               updated_at=NOW()
          FROM candidates c
         WHERE po.id=c.id
         RETURNING po.id,po.provider,po.operation_type,po.owner_id
    `, [safeLimit]);
    return result.rows;
}

async function scan() {
    const findings = [];
    // A terminal renewal operation is only actionable while its original local
    // subscription is still the same live recurring provider contract. If the
    // subscription has since been migrated/manualised/replaced, preserving the
    // operation as audit history is useful but continuing to page an operator is
    // not. Retire those rows before reading the active manual-review set.
    await retireObsoleteManualRenewalOperations();

    // These reads deliberately fail the job if PostgreSQL/schema permissions are
    // broken. A watchdog that silently turns query failures into "0 findings"
    // would recreate the exact failure mode this job exists to prevent.
    //
    // The customer-access invariants intentionally do NOT reuse reconciliation
    // candidate functions. They query durable desired-state authority and actual
    // account state independently, so a bug in the worker cannot teach the
    // watchdog the same wrong answer.
    const [
        permanentRefunds,
        manualProviderOps,
        deletionFailures,
        staleCreationIntents,
        contaminatedPlans,
        strandedProvisioning,
        stalePaymentEvents,
        uncertainNotifications,
        jellyfinAdminAuthorityViolations,
        duplicateActiveJellyfinLanes,
        actorlessAdministrativeHolds,
        accessHoldSummaryDrift
    ] = await Promise.all([
        query(`
            SELECT o.customer_id,o.subscription_id,s.source,s.provider_subscription_id
            FROM customer_entitlement_overrides o
            JOIN subscriptions s ON s.id=o.subscription_id
            WHERE o.permanent_access=TRUE AND o.revoked_at IS NULL
              AND s.refund_terminated_at IS NOT NULL
            ORDER BY o.updated_at
            LIMIT 100
        `),
        query(`
            SELECT id,provider,operation_type,owner_id,last_error,updated_at
            FROM provider_operations
            WHERE manual_review_required=TRUE
            ORDER BY updated_at
            LIMIT 100
        `),
        query(`
            SELECT id,customer_id,status,attempt_count,last_error,updated_at,next_attempt_at
            FROM customer_deletion_jobs
            WHERE status='failed'
               OR (status='running' AND updated_at<NOW()-INTERVAL '20 minutes')
            ORDER BY updated_at
            LIMIT 100
        `),
        query(`
            SELECT id,customer_id,server_id,username,status,remote_user_id,last_error,updated_at
            FROM jellyfin_account_creation_intents
            WHERE updated_at<NOW()-INTERVAL '45 minutes'
            ORDER BY updated_at
            LIMIT 100
        `),
        query(`
            SELECT id,code,name,server_class,is_free_tier,price_minor,billing_interval
            FROM plans
            WHERE server_class='free' AND COALESCE(is_free_tier,FALSE)=FALSE
            ORDER BY updated_at DESC
            LIMIT 100
        `),
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
        `),
        query(`
            SELECT id,provider,provider_event_id,event_type,processing_error,processing_started_at,created_at
            FROM payment_events
            WHERE provider IN('stripe','paypal','plisio')
              AND processed_at IS NULL
              AND created_at<NOW()-INTERVAL '45 minutes'
            ORDER BY created_at
            LIMIT 100
        `),
        query(`
            SELECT id,channel,message_type,status,attempts,last_attempt_at,last_error,updated_at
            FROM notification_outbox
            WHERE (
                status='dead'
                AND COALESCE(last_error,'') LIKE 'Delivery outcome is uncertain%'
            ) OR (
                status='sending'
                AND last_attempt_at<NOW()-INTERVAL '20 minutes'
            )
            ORDER BY updated_at
            LIMIT 100
        `),
        query(`
            SELECT ctl.customer_id,ctl.mode,ctl.server_id,ctl.reason,ctl.updated_at,
                   CASE
                     WHEN ctl.mode='admin_removed' THEN 'active_account_despite_admin_removed'
                     WHEN ctl.mode='admin_server_pin' THEN 'pinned_account_missing_on_target_server'
                     ELSE 'account_missing_despite_admin_present'
                   END AS violation
            FROM customer_service_admin_control ctl
            WHERE ctl.service='jellyfin'
              AND ctl.updated_at<NOW()-INTERVAL '2 minutes'
              AND (
                (ctl.mode='admin_present' AND NOT EXISTS(
                    SELECT 1 FROM jellyfin_accounts ja
                    WHERE ja.customer_id=ctl.customer_id
                      AND ja.account_purpose='jellyfin'
                      AND ja.disabled=FALSE
                ))
                OR
                (ctl.mode='admin_server_pin' AND NOT EXISTS(
                    SELECT 1 FROM jellyfin_accounts ja
                    WHERE ja.customer_id=ctl.customer_id
                      AND ja.account_purpose='jellyfin'
                      AND ja.disabled=FALSE
                      AND ja.server_id=ctl.server_id
                ))
                OR
                (ctl.mode='admin_removed' AND EXISTS(
                    SELECT 1 FROM jellyfin_accounts ja
                    WHERE ja.customer_id=ctl.customer_id
                      AND ja.account_purpose='jellyfin'
                      AND ja.disabled=FALSE
                ))
              )
            ORDER BY ctl.updated_at
            LIMIT 100
        `),
        query(`
            SELECT customer_id,access_lane,COUNT(*)::int AS active_count,
                   array_agg(id::text ORDER BY created_at) AS account_ids,
                   array_agg(server_id::text ORDER BY created_at) AS server_ids
            FROM jellyfin_accounts
            WHERE account_purpose='jellyfin' AND disabled=FALSE
            GROUP BY customer_id,access_lane
            HAVING COUNT(*)>1 AND MAX(updated_at)<NOW()-INTERVAL '2 minutes'
            ORDER BY COUNT(*) DESC,customer_id
            LIMIT 100
        `),
        query(ACTORLESS_ADMIN_HOLDS_SQL, [ADMIN_ACTOR_ENFORCED_AT, LEGACY_ACTORLESS_ADMIN_REPAIR]),
        query(`
            SELECT c.id AS customer_id,c.access_paused_at,c.access_hold_reason,
                   EXISTS(
                     SELECT 1 FROM customer_access_holds h
                     WHERE h.customer_id=c.id AND h.released_at IS NULL
                   ) AS has_active_hold
            FROM customers c
            WHERE (c.access_paused_at IS NULL AND EXISTS(
                       SELECT 1 FROM customer_access_holds h
                       WHERE h.customer_id=c.id AND h.released_at IS NULL
                   ))
               OR (c.access_paused_at IS NOT NULL AND NOT EXISTS(
                       SELECT 1 FROM customer_access_holds h
                       WHERE h.customer_id=c.id AND h.released_at IS NULL
                   ))
            ORDER BY c.updated_at
            LIMIT 100
        `)
    ]);

    for (const row of permanentRefunds.rows) findings.push(finding('refunded_permanent_access', row, `Refund-terminated subscription ${row.subscription_id} still has Permanent Access.`));
    for (const row of manualProviderOps.rows) findings.push(finding('provider_manual_review', row, `${row.provider} ${row.operation_type} requires manual review${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of deletionFailures.rows) findings.push(finding('customer_deletion_stuck', row, `Customer deletion ${row.id} is ${row.status} after ${row.attempt_count || 0} attempt(s)${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of staleCreationIntents.rows) findings.push(finding('jellyfin_creation_intent_stale', row, `Jellyfin creation intent ${row.id} remains ${row.status} on server ${row.server_id}${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of contaminatedPlans.rows) findings.push(finding('paid_plan_on_free_pool', row, `Plan ${row.code || row.name || row.id} is not a Free plan but uses server_class=free.`));
    for (const row of strandedProvisioning.rows) findings.push(finding('customer_access_not_converged', row, `Customer access is ${row.status} after ${row.consecutive_failures || 0} failure(s)${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of stalePaymentEvents.rows) findings.push(finding('payment_event_stale', row, `${row.provider} ${row.event_type || 'payment event'} ${row.provider_event_id} has remained unprocessed${row.processing_error ? `: ${row.processing_error}` : ''}`));
    for (const row of uncertainNotifications.rows) findings.push(finding('notification_delivery_uncertain', row, `${row.channel} ${row.message_type || 'notification'} ${row.id} has an uncertain delivery outcome after ${row.attempts || 0} attempt(s)${row.last_error ? `: ${row.last_error}` : ''}`));
    for (const row of jellyfinAdminAuthorityViolations.rows) findings.push(finding('jellyfin_admin_authority_violation', row, `${row.violation} for ${row.mode}${row.server_id ? ` on server ${row.server_id}` : ''}${row.reason ? `: ${row.reason}` : ''}`));
    for (const row of duplicateActiveJellyfinLanes.rows) findings.push(finding('jellyfin_duplicate_active_lane', row, `Customer has ${row.active_count} active Jellyfin accounts in ${row.access_lane || 'unknown'} lane across server(s) ${(row.server_ids || []).join(', ')}.`));
    for (const row of actorlessAdministrativeHolds.rows) findings.push(finding('actorless_administrative_hold', row, `Active ${row.hold_type} hold ${row.id} was created without an administrator actor${row.reason ? `: ${row.reason}` : ''}`));
    for (const row of accessHoldSummaryDrift.rows) findings.push(finding('access_hold_summary_drift', row, `Legacy access summary disagrees with canonical holds (access_paused_at=${row.access_paused_at || 'null'}, hasActiveHold=${Boolean(row.has_active_hold)}).`));

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
        subject: 'Customer/revenue integrity failure',
        text: `${findings.length} customer/revenue integrity condition${findings.length === 1 ? '' : 's'} require attention.\n\n${top}${extra}`,
        adminSubject: `URGENT: ${findings.length} customer/revenue integrity failure${findings.length === 1 ? '' : 's'}`,
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

module.exports = {
    ALERT_BUCKET_MS,
    ADMIN_ACTOR_ENFORCED_AT,
    LEGACY_ACTORLESS_ADMIN_REPAIR,
    ACTORLESS_ADMIN_HOLDS_SQL,
    clean,
    finding,
    retireObsoleteManualRenewalOperations,
    scan,
    fingerprint,
    notify,
    run
};
