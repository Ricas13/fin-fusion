'use strict';

const { query, transaction } = require('../db');
const providerReconciliation = require('./incident-reconciliation');
const billingControl = require('./billing-control');
const provisioning = require('../jellyfin/resilient-provisioning');
const installRecovery = require('../stremio/install-credential-recovery');

const RECOVERABLE_PROVIDERS = new Set(['stripe', 'paypal']);
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);

function clean(value, max = 700) {
    return String(value == null ? '' : value)
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, max);
}

function serviceType(row) {
    return String(row?.service_type_snapshot || row?.service_type || 'jellyfin').trim().toLowerCase();
}

function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
}

function fallbackPaidEnd(row) {
    const start = validDate(row?.starts_at);
    const days = Math.max(1, Math.min(3650, Number(row?.duration_days_snapshot || 0) || 0));
    if (!start || !days) return null;
    return new Date(start.getTime() + days * 86400000);
}

function snapshotPaidState(lostIncident, subscription) {
    const snapshot = lostIncident?.metadata?.moneyLossSubscriptionSnapshot || {};
    const periodEnd = validDate(snapshot.currentPeriodEnd) || fallbackPaidEnd(subscription);
    const serviceExtensionDays = Math.max(0, Math.min(3650, Number(snapshot.serviceExtensionDays || 0) || 0));
    const priorStatus = String(snapshot.status || 'active').toLowerCase();
    const status = LIVE_STATUSES.has(priorStatus) ? priorStatus : 'active';
    return {
        periodEnd,
        serviceExtensionDays,
        status,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd === true
    };
}

function accessEnd(row) {
    const end = validDate(row?.current_period_end);
    if (!end) return null;
    return new Date(end.getTime() + Math.max(0, Number(row?.service_extension_days || 0)) * 86400000);
}

function hasEffectiveTime(row, now = new Date()) {
    const end = accessEnd(row);
    return Boolean(end && end > now && LIVE_STATUSES.has(String(row?.status || '').toLowerCase()));
}

async function dueIncidents({ limit = 10 } = {}) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 10));
    const result = await query(`
        SELECT won.id
        FROM payment_incidents won
        JOIN subscriptions s
          ON s.source=won.provider
         AND s.provider_subscription_id=won.provider_subscription_id
         AND s.customer_id=won.customer_id
         AND s.superseded_by IS NULL
        WHERE won.provider IN('stripe','paypal')
          AND won.incident_status='won'
          AND won.incident_type IN('dispute','chargeback')
          AND won.provider_case_id IS NOT NULL
          AND won.provider_subscription_id IS NOT NULL
          AND s.refund_terminated_at IS NOT NULL
          AND COALESCE(won.metadata->'chargebackRecovery'->>'completed','false')<>'true'
          AND EXISTS (
              SELECT 1
              FROM payment_incidents lost
              WHERE lost.provider=won.provider
                AND lost.provider_case_id=won.provider_case_id
                AND lost.provider_subscription_id=won.provider_subscription_id
                AND lost.customer_id IS NOT DISTINCT FROM won.customer_id
                AND lost.incident_type='chargeback'
                AND lost.incident_status='lost'
                AND lost.created_at<=won.created_at
          )
        ORDER BY won.created_at,won.id
        LIMIT $1
    `, [bounded]);
    return result.rows.map(row => row.id);
}

async function prepareRecovery(incidentId, evidence) {
    return transaction(async client => {
        const winResult = await client.query(`SELECT * FROM payment_incidents WHERE id=$1 FOR UPDATE`, [incidentId]);
        if (!winResult.rowCount) throw new Error('Winning payment incident no longer exists.');
        const win = winResult.rows[0];
        if (!RECOVERABLE_PROVIDERS.has(String(win.provider || '').toLowerCase())) throw new Error('Chargeback recovery supports Stripe and PayPal only.');
        if (!['dispute', 'chargeback'].includes(String(win.incident_type || '')) || win.incident_status !== 'won') throw new Error('Payment incident is not a provider-confirmed merchant win.');
        if (!win.provider_case_id || !win.provider_subscription_id || !win.customer_id) throw new Error('Winning payment incident is missing exact recovery identity.');

        const matchedSubscriptionId = evidence?.match?.subscription_id || evidence?.snapshot?.matchedSubscriptionId || null;
        if (!matchedSubscriptionId || evidence?.snapshot?.restoreEligible !== true) throw new Error('Current provider state does not prove that this chargeback was won.');

        const subscriptionResult = await client.query(`
            SELECT s.*,p.service_type,p.is_addon
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            WHERE s.id=$1 AND s.customer_id=$2
              AND s.source=$3 AND s.provider_subscription_id=$4
              AND s.superseded_by IS NULL
            FOR UPDATE OF s
        `, [matchedSubscriptionId, win.customer_id, win.provider, win.provider_subscription_id]);
        if (!subscriptionResult.rowCount) throw new Error('Provider recovery did not match the exact local subscription.');
        const subscription = subscriptionResult.rows[0];

        const lostResult = await client.query(`
            SELECT *
            FROM payment_incidents lost
            WHERE lost.provider=$1
              AND lost.provider_case_id=$2
              AND lost.provider_subscription_id=$3
              AND lost.customer_id IS NOT DISTINCT FROM $4::uuid
              AND lost.incident_type='chargeback'
              AND lost.incident_status='lost'
              AND lost.created_at<=$5
            ORDER BY lost.created_at DESC,lost.id DESC
            LIMIT 1
            FOR UPDATE
        `, [win.provider, win.provider_case_id, win.provider_subscription_id, win.customer_id, win.created_at]);
        if (!lostResult.rowCount) return { changed: false, reason: 'no_matching_prior_loss', win, subscription };
        const lost = lostResult.rows[0];

        const blocking = await client.query(`
            SELECT pi.id,pi.incident_type,pi.provider_case_id
            FROM payment_incidents pi
            WHERE pi.provider=$1
              AND pi.provider_subscription_id=$2
              AND pi.customer_id IS NOT DISTINCT FROM $3::uuid
              AND (
                  (
                      pi.incident_type='refund'
                      AND COALESCE(pi.metadata->>'fullRefund','false')='true'
                      AND (
                          COALESCE($4::text,'payment')<>'subscription'
                          OR COALESCE(pi.metadata->>'currentTermLoss','false')='true'
                      )
                  )
                  OR (
                      pi.incident_type='chargeback'
                      AND pi.incident_status='lost'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM payment_incidents recovered
                          WHERE recovered.provider=pi.provider
                            AND recovered.provider_case_id=pi.provider_case_id
                            AND recovered.provider_subscription_id=pi.provider_subscription_id
                            AND recovered.customer_id IS NOT DISTINCT FROM pi.customer_id
                            AND recovered.incident_status='won'
                            AND recovered.created_at>=pi.created_at
                            AND COALESCE(recovered.metadata->'providerReconciliation'->>'restoreEligible','false')='true'
                            AND recovered.metadata->'providerReconciliation'->>'matchedSubscriptionId'=$5::text
                      )
                  )
              )
            ORDER BY pi.created_at DESC,pi.id DESC
            LIMIT 1
        `, [win.provider, win.provider_subscription_id, win.customer_id, subscription.billing_mode || 'payment', subscription.id]);
        if (blocking.rowCount) return { changed: false, reason: 'another_terminal_money_loss_remains', blocker: blocking.rows[0], win, subscription, lost };

        const prior = snapshotPaidState(lost, subscription);
        const recurring = billingControl.isRecurring(subscription);
        if (!subscription.refund_terminated_at) return { changed: false, reason: 'terminal_marker_already_cleared', win, subscription, lost, recurring, prior };

        if (recurring) {
            const restored = await client.query(`
                UPDATE subscriptions
                SET refund_terminated_at=NULL,
                    current_period_end=COALESCE($2::timestamptz,current_period_end),
                    service_extension_days=$3,
                    status='cancelled',
                    updated_at=NOW()
                WHERE id=$1
                RETURNING *
            `, [subscription.id, prior.periodEnd, prior.serviceExtensionDays]);
            return { changed: true, win, subscription: restored.rows[0], lost, recurring: true, prior };
        }

        if (!prior.periodEnd) throw new Error('One-time chargeback recovery cannot reconstruct the original paid-through end safely.');
        const paidThrough = new Date(prior.periodEnd.getTime() + prior.serviceExtensionDays * 86400000);
        const restoredStatus = paidThrough > new Date() ? prior.status : 'expired';
        const restored = await client.query(`
            UPDATE subscriptions
            SET refund_terminated_at=NULL,
                status=$2,
                current_period_end=$3,
                service_extension_days=$4,
                cancel_at_period_end=$5,
                updated_at=NOW()
            WHERE id=$1
            RETURNING *
        `, [subscription.id, restoredStatus, prior.periodEnd, prior.serviceExtensionDays, prior.cancelAtPeriodEnd]);
        return { changed: true, win, subscription: restored.rows[0], lost, recurring: false, prior };
    });
}

async function resetRevokedStremio(subscription) {
    if (!subscription || !['stremio', 'bundle'].includes(serviceType(subscription))) return 0;
    const result = await query(`
        UPDATE stremio_entitlements
        SET status='pending',token_hash=NULL,token_hint=NULL,
            server_id=NULL,jellyfin_account_id=NULL,jellyfin_access_token_encrypted=NULL,
            jellyfin_token_issued_at=NULL,revoked_at=NULL,last_error=NULL,updated_at=NOW()
        WHERE subscription_id=$1 AND customer_id=$2 AND status='revoked'
    `, [subscription.id, subscription.customer_id]);
    if (result.rowCount) {
        await installRecovery.clear(subscription.customer_id).catch(error => {
            console.warn('Chargeback recovery could not clear stale Stremio install recovery state:', clean(error));
        });
    }
    return result.rowCount;
}

async function markCompleted(incidentId, subscription, { restoredAccess, stremioReset, recurring, syncResult = null } = {}) {
    await query(`
        UPDATE payment_incidents
        SET metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb,updated_at=NOW()
        WHERE id=$1
    `, [incidentId, JSON.stringify({ chargebackRecovery: {
        completed: true,
        completedAt: new Date().toISOString(),
        subscriptionId: subscription.id,
        customerId: subscription.customer_id,
        recurring: Boolean(recurring),
        restoredAccess: Boolean(restoredAccess),
        stremioReset: Number(stremioReset || 0),
        providerStatus: syncResult?.remote?.remoteStatus || syncResult?.remote?.status || null
    } })]);
    await query(`
        INSERT INTO audit_log(action,entity_type,entity_id,metadata)
        VALUES('billing.subscription.chargeback_recovered','subscription',$1,$2::jsonb)
    `, [subscription.id, JSON.stringify({
        customerId: subscription.customer_id,
        winningIncidentId: incidentId,
        provider: subscription.source,
        providerSubscriptionId: subscription.provider_subscription_id,
        restoredAccess: Boolean(restoredAccess),
        recurring: Boolean(recurring),
        stremioReset: Number(stremioReset || 0)
    })]);
}

async function recoverIncident(incidentId, {
    reconcileProvider = providerReconciliation.reconcile,
    syncRecurring = billingControl.syncSubscription,
    reconcileCustomer = provisioning.reconcileCustomer
} = {}) {
    const evidence = await reconcileProvider(incidentId, null);
    if (!evidence?.match || evidence?.snapshot?.restoreEligible !== true) {
        throw new Error('Provider current-state verification did not prove a recoverable chargeback win.');
    }

    const prepared = await prepareRecovery(incidentId, evidence);
    if (!prepared.changed && !['terminal_marker_already_cleared'].includes(prepared.reason)) return prepared;

    let syncResult = null;
    if (prepared.recurring) {
        syncResult = await syncRecurring(prepared.subscription.id);
        if (!syncResult?.ok) throw new Error(`Recurring provider state could not be refreshed after chargeback win: ${syncResult?.error || 'unknown provider sync failure'}`);
    }

    const current = (await query(`
        SELECT s.*,p.service_type,p.is_addon
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1
    `, [prepared.subscription.id])).rows[0];
    if (!current) throw new Error('Recovered subscription disappeared before access reconciliation.');

    const restoredAccess = hasEffectiveTime(current);
    const stremioReset = restoredAccess ? await resetRevokedStremio(current) : 0;
    await reconcileCustomer(current.customer_id);
    await markCompleted(incidentId, current, { restoredAccess, stremioReset, recurring: prepared.recurring, syncResult });
    return { changed: true, incidentId, subscriptionId: current.id, customerId: current.customer_id, recurring: prepared.recurring, restoredAccess, stremioReset, syncResult };
}

async function recoverDue({ limit = 10, ...options } = {}) {
    const ids = await dueIncidents({ limit });
    const summary = { total: ids.length, processed: 0, recovered: 0, failed: 0, failures: [] };
    for (const incidentId of ids) {
        summary.processed += 1;
        try {
            const result = await recoverIncident(incidentId, options);
            if (result.changed) summary.recovered += 1;
        } catch (error) {
            summary.failed += 1;
            summary.failures.push({ incidentId, error: clean(error) });
        }
    }
    return summary;
}

module.exports = {
    RECOVERABLE_PROVIDERS,
    LIVE_STATUSES,
    clean,
    serviceType,
    fallbackPaidEnd,
    snapshotPaidState,
    accessEnd,
    hasEffectiveTime,
    dueIncidents,
    prepareRecovery,
    resetRevokedStremio,
    markCompleted,
    recoverIncident,
    recoverDue
};
