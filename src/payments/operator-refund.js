'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const incidents = require('./incidents');
const financialState = require('./provider-financial-state');
const subscriptionTermination = require('./subscription-termination');
const accessExtensions = require('./subscription-access-extensions');
const referrals = require('../referrals');
const provisioning = require('../jellyfin/resilient-provisioning');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stripe and PayPal deliver refund events by webhook, which already record the incident, the
// ledger entry and the referral adjustment. Recording the same refund here would count it twice.
const WEBHOOK_PROVIDERS = new Set(['stripe', 'paypal']);

function amountMinor(raw) {
    const text = String(raw ?? '').trim().replace(/,/g, '');
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new Error('Enter the refunded amount as a number with at most two decimals, for example 10.00.');
    const minor = Math.round(Number(text) * 100);
    if (!Number.isInteger(minor) || minor < 1) throw new Error('The refunded amount must be at least 0.01.');
    return minor;
}

// An administrator refunded a customer outside the app: crypto (Plisio has no refund events) or
// cash. Nothing here moves money. It records that the refund happened so the ledger, referral
// credit and the customer's access match reality. A full refund ends the plan; a partial refund
// is only recorded. Stripe and PayPal plans are refused: their refunds arrive automatically.
async function record({ customerId, subscriptionId, amount, full = false, reason, submissionId, actorUserId = null }) {
    const note = String(reason || '').trim();
    if (note.length < 10 || note.length > 500) throw new Error('Enter a reason of 10 to 500 characters.');
    if (!UUID.test(String(submissionId || ''))) throw new Error('This form expired. Reload the page and try again.');
    const minor = amountMinor(amount);
    const sub = (await query(`
        SELECT s.id,s.customer_id,s.source,s.provider_subscription_id,s.status,
               COALESCE(NULLIF(s.currency_snapshot,''),p.currency,'GBP') AS currency,
               COALESCE(s.price_minor_snapshot,p.price_minor,0)::bigint AS price_minor
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1 AND s.customer_id=$2 AND s.superseded_by IS NULL
    `, [subscriptionId, customerId])).rows[0];
    if (!sub) throw new Error('Choose one of this customer\'s current plans.');
    const source = String(sub.source || '').toLowerCase();
    if (WEBHOOK_PROVIDERS.has(source)) throw new Error(`${source === 'stripe' ? 'Stripe' : 'PayPal'} refunds are recorded automatically when you refund in the ${source === 'stripe' ? 'Stripe' : 'PayPal'} dashboard. Nothing to record here.`);
    const currency = String(sub.currency || 'GBP').toUpperCase();
    const providerRef = String(sub.provider_subscription_id || '').trim();
    // Exactly two shapes are supported: a Plisio-paid plan, or a plan with no provider reference at all (cash/manual).
    const plisioBacked = source === 'plisio' && Boolean(providerRef);
    const providerless = !providerRef;
    if (!plisioBacked && !providerless) throw new Error('This plan is linked to a payment provider that reports its own refunds, so it cannot be recorded here.');

    const sid = submissionId.toLowerCase();
    const fingerprint = crypto.createHash('sha256').update(`${sub.id}|${minor}|${full ? 1 : 0}|${note}`).digest('hex');
    let eventId = `operator-refund:${sid}`;

    // Everything that decides whether this refund may run happens under a lock on the SUBSCRIPTION,
    // so two administrators refunding the same plan are serialised: the cumulative cap is checked
    // against refunds that are completed or still in flight (failed attempts do not count), and the
    // attempt is recorded in the same transaction. A failed attempt with the same amount and reason is
    // resumed under its original id instead of creating a second set of effects.
    const decision = await transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`operator-refund-sub:${sub.id}`]);
        const own = await client.query(`
            SELECT
              EXISTS(SELECT 1 FROM audit_log WHERE action='billing.refund.recorded_externally_completed' AND metadata->>'submissionId'=$1) AS completed,
              EXISTS(SELECT 1 FROM audit_log WHERE action='billing.refund.recorded_externally_failed' AND metadata->>'submissionId'=$1) AS failed,
              (SELECT MAX(created_at) FROM audit_log WHERE action='billing.refund.recorded_externally' AND metadata->>'submissionId'=$1) AS attempted_at`, [sid]);
        const row = own.rows[0];
        if (row.completed) throw new Error('This refund was already recorded.');
        if (row.attempted_at && !row.failed && Date.now() - new Date(row.attempted_at).getTime() < 5 * 60 * 1000) throw new Error('This refund is already being recorded. Wait a moment and reload.');
        if (row.attempted_at) return { resume: true, submission: sid, eventId };

        // A failed earlier attempt with the same plan, amount and reason is resumed rather than repeated.
        const earlier = await client.query(`
            SELECT a.metadata->>'submissionId' AS submission_id, a.metadata->>'eventId' AS event_id
            FROM audit_log a
            WHERE a.action='billing.refund.recorded_externally' AND a.entity_id=$1 AND a.metadata->>'fingerprint'=$2
              AND EXISTS(SELECT 1 FROM audit_log f WHERE f.action='billing.refund.recorded_externally_failed' AND f.metadata->>'submissionId'=a.metadata->>'submissionId')
              AND NOT EXISTS(SELECT 1 FROM audit_log c WHERE c.action='billing.refund.recorded_externally_completed' AND c.metadata->>'submissionId'=a.metadata->>'submissionId')
            ORDER BY a.created_at DESC LIMIT 1`, [String(sub.id), fingerprint]);
        if (earlier.rowCount) return { resume: true, submission: earlier.rows[0].submission_id, eventId: earlier.rows[0].event_id };

        const priorAudit = Number((await client.query(`
            SELECT COALESCE(SUM((a.metadata->>'amountMinor')::bigint),0) AS n
            FROM audit_log a
            WHERE a.entity_id=$1 AND a.action='billing.refund.recorded_externally'
              AND NOT (
                EXISTS(SELECT 1 FROM audit_log f WHERE f.action='billing.refund.recorded_externally_failed' AND f.metadata->>'submissionId'=a.metadata->>'submissionId')
                AND NOT EXISTS(SELECT 1 FROM audit_log c WHERE c.action='billing.refund.recorded_externally_completed' AND c.metadata->>'submissionId'=a.metadata->>'submissionId'))`, [String(sub.id)])).rows[0].n);
        const priorIncidents = plisioBacked ? Number((await client.query(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM payment_incidents WHERE provider='plisio' AND provider_subscription_id=$1 AND incident_type='refund' AND provider_event_id NOT LIKE 'operator-refund:%'`, [providerRef])).rows[0].n) : 0;
        const alreadyRefunded = priorAudit + priorIncidents;
        if (Number(sub.price_minor) > 0 && alreadyRefunded + minor > Number(sub.price_minor)) {
            throw new Error(`That would refund more than the plan cost. Already refunded or in progress: ${(alreadyRefunded / 100).toFixed(2)} of ${(Number(sub.price_minor) / 100).toFixed(2)} ${currency}.`);
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally','subscription',$2,$3::jsonb)`,
            [actorUserId, sub.id, JSON.stringify({ customerId, amountMinor: minor, currency, full: Boolean(full), reason: note, submissionId: sid, eventId, fingerprint, source: source || 'manual', plisioBacked })]);
        return { resume: false, submission: sid, eventId };
    });
    eventId = decision.eventId;
    const submission = decision.submission;

    try {
        let recorded = null;
        if (plisioBacked) {
            // Both writes are idempotent on the event id, so a resumed attempt repeats them harmlessly.
            recorded = await incidents.record({
                provider: 'plisio', eventId, caseId: eventId, kind: 'refund', status: 'recorded',
                identity: { scope: 'direct', customerId }, providerSubscriptionId: providerRef,
                amountMinor: minor, currency,
                metadata: { fullRefund: Boolean(full), operatorRecorded: true, recordedBy: actorUserId, reason: note }
            });
            await financialState.recordTransaction({
                provider: 'plisio', providerTransactionId: eventId, transactionType: 'refund', transactionStatus: 'succeeded',
                occurredAt: new Date(), currency, grossMinor: -minor, feeMinor: 0, netMinor: -minor,
                providerReferenceId: providerRef, customerId,
                metadata: { providerAuthoritative: true, operatorAttested: true, attestedBy: String(actorUserId || ''), attestationReason: note, feeDataAvailable: false, fullRefund: Boolean(full), subscriptionId: String(sub.id), source: 'operator_recorded_refund' }
            });
            // Referral credit follows the refunded value, as the Stripe and PayPal handlers do. A failure
            // fails the whole attempt (so it is retried), never silently skipped. Cash refunds have no
            // provider payment to reverse a reward against, so they do not touch referrals.
            await referrals.revisitRewardAfterAdversePayment({ referredCustomerId: customerId, incidentId: recorded?.incident?.id || null, reason: eventId, amountMinor: minor, fullLoss: Boolean(full) });
        }

        let ended = false;
        if (full) {
            const current = (await query(`SELECT status,service_extension_days FROM subscriptions WHERE id=$1`, [sub.id])).rows[0];
            if (current && !(current.status === 'cancelled' && Number(current.service_extension_days || 0) === 0)) {
                const terminated = await subscriptionTermination.terminateForRefund(sub.id, customerId, { actorUserId, reason: `Refund recorded by administrator: ${note}`, reference: eventId });
                if (terminated.changed) await accessExtensions.restoreActivePurchasedDays(sub.id, customerId);
                ended = Boolean(terminated.changed);
            } else ended = true;
            try { await provisioning.reconcileCustomer(customerId); } catch (_) { console.warn('Refund recorded; access reconcile failed and will be retried by the reconciliation job.'); }
        }
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally_completed','subscription',$2,$3::jsonb)`,
            [actorUserId, sub.id, JSON.stringify({ submissionId: submission, eventId, ended })]);
        return { eventId, ended, amountMinor: minor, currency, resumed: decision.resume };
    } catch (error) {
        // Mark the attempt failed so it no longer counts toward the cap and can be resumed with the
        // same amount and reason. The administrator is told exactly that.
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally_failed','subscription',$2,$3::jsonb)`,
            [actorUserId, sub.id, JSON.stringify({ submissionId: submission, eventId, error: String(error.message || error).slice(0, 300) })]).catch(() => {});
        const failure = new Error(`The refund was only partly recorded (${String(error.message || 'unexpected error').slice(0, 150)}). Submit the same amount and reason again to finish it; nothing is repeated or double counted.`);
        failure.cause = error;
        throw failure;
    }
}

module.exports = { record, amountMinor, newSubmissionId: () => crypto.randomUUID() };
