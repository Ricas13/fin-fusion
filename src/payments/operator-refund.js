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
    const plisioBacked = source === 'plisio' && Boolean(providerRef);

    // Cumulative cap: everything already refunded for this plan plus this refund may not exceed
    // what it cost. Prior amounts come from earlier recorded refunds (this form) and, for Plisio
    // plans, refund incidents.
    const eventId = `operator-refund:${submissionId.toLowerCase()}`;
    const priorAudit = Number((await query(`SELECT COALESCE(SUM((metadata->>'amountMinor')::bigint),0) AS n FROM audit_log WHERE entity_id=$1 AND action='billing.refund.recorded_externally'`, [sub.id])).rows[0].n);
    const priorIncidents = plisioBacked ? Number((await query(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM payment_incidents WHERE provider='plisio' AND provider_subscription_id=$1 AND incident_type='refund' AND provider_event_id NOT LIKE 'operator-refund:%'`, [providerRef])).rows[0].n) : 0;
    const alreadyRefunded = priorAudit + priorIncidents;
    if (Number(sub.price_minor) > 0 && alreadyRefunded + minor > Number(sub.price_minor)) {
        throw new Error(`That would refund more than the plan cost. Already refunded: ${(alreadyRefunded / 100).toFixed(2)} of ${(Number(sub.price_minor) / 100).toFixed(2)} ${currency}.`);
    }

    // The attempt is audited first, atomically with the duplicate check. If the audit cannot be
    // written nothing happens, and submitting the same form twice records the refund once.
    await transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventId]);
        const seen = await client.query(`SELECT 1 FROM audit_log WHERE action='billing.refund.recorded_externally' AND metadata->>'submissionId'=$1 LIMIT 1`, [submissionId.toLowerCase()]);
        if (seen.rowCount) throw new Error('This refund was already recorded.');
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally','subscription',$2,$3::jsonb)`,
            [actorUserId, sub.id, JSON.stringify({ customerId, amountMinor: minor, currency, full: Boolean(full), reason: note, submissionId: submissionId.toLowerCase(), eventId, source: source || 'manual', plisioBacked })]);
    });

    let recorded = null;
    if (plisioBacked) {
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
    }
    // Referral credit follows the refunded value, exactly as the Stripe and PayPal handlers do.
    try {
        await referrals.revisitRewardAfterAdversePayment({ referredCustomerId: customerId, incidentId: recorded?.incident?.id || null, reason: eventId, amountMinor: minor, fullLoss: Boolean(full) });
    } catch (_) { console.warn('Refund recorded; referral credit adjustment failed and needs a manual check.'); }

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
        [actorUserId, sub.id, JSON.stringify({ eventId, ended })]);
    return { eventId, ended, amountMinor: minor, currency };
}

module.exports = { record, amountMinor, newSubmissionId: () => crypto.randomUUID() };
