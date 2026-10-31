'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const incidents = require('./incidents');
const financialState = require('./provider-financial-state');
const subscriptionTermination = require('./subscription-termination');
const accessExtensions = require('./subscription-access-extensions');
const provisioning = require('../jellyfin/resilient-provisioning');

const PROVIDERS = new Set(['stripe', 'paypal', 'plisio']);

function amountMinor(raw) {
    const value = Number.parseFloat(String(raw ?? '').replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) throw new Error('Enter the refunded amount (greater than zero).');
    const minor = Math.round(value * 100);
    if (minor > 100000000) throw new Error('Amount is too large.');
    return minor;
}

// An administrator refunded a customer outside the app (in the Stripe, PayPal or Plisio
// dashboard, or in cash). Nothing here moves money. It records that the refund happened so the
// ledger, referral credit and the customer's access match reality: a full refund ends the plan
// exactly as a provider refund event would; a partial refund is only recorded.
async function record({ customerId, subscriptionId, amount, full = false, reason, actorUserId = null }) {
    const note = String(reason || '').trim();
    if (note.length < 10 || note.length > 500) throw new Error('Enter a reason of 10 to 500 characters.');
    const minor = amountMinor(amount);
    const sub = (await query(`
        SELECT s.id,s.customer_id,s.source,s.provider_subscription_id,s.status,
               COALESCE(NULLIF(s.currency_snapshot,''),p.currency,'GBP') AS currency,
               COALESCE(s.price_minor_snapshot,p.price_minor,0)::bigint AS price_minor
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1 AND s.customer_id=$2 AND s.superseded_by IS NULL
    `, [subscriptionId, customerId])).rows[0];
    if (!sub) throw new Error('Choose one of this customer\'s current plans.');
    const currency = String(sub.currency || 'GBP').toUpperCase();
    if (Number(sub.price_minor) > 0 && minor > Number(sub.price_minor) * 2) throw new Error('The refunded amount is far above the plan price. Check the amount.');

    const eventId = `operator-refund:${crypto.randomUUID()}`;
    const source = String(sub.source || '').toLowerCase();
    const providerBacked = PROVIDERS.has(source) && String(sub.provider_subscription_id || '').trim();
    const provider = providerBacked ? source : 'plisio';

    // 1. The refund as a payment incident (bookkeeping, referral reversal and, for a full
    //    refund of a provider-backed plan, the normal automatic termination rules).
    if (providerBacked) {
        await incidents.record({
            provider, eventId, caseId: eventId, kind: 'refund', status: 'recorded',
            identity: { scope: 'direct', customerId }, providerSubscriptionId: sub.provider_subscription_id,
            amountMinor: minor, currency,
            metadata: { fullRefund: Boolean(full), operatorRecorded: true, recordedBy: actorUserId, reason: note }
        });
    }
    // 2. The negative ledger entry, clearly marked as operator-recorded.
    await financialState.recordTransaction({
        provider, providerTransactionId: eventId, transactionType: 'refund', transactionStatus: 'succeeded',
        occurredAt: new Date(), currency, grossMinor: -minor, feeMinor: 0, netMinor: -minor,
        providerReferenceId: sub.provider_subscription_id || String(sub.id), customerId,
        metadata: { providerAuthoritative: true, operatorAttested: true, attestedBy: String(actorUserId || ''), attestationReason: note, feeDataAvailable: false, fullRefund: Boolean(full), subscriptionId: String(sub.id), source: 'operator_recorded_refund' }
    });
    // 3. A full refund removes the plan even when the plan has no provider reference or the
    //    automatic rules left it running (the administrator is the authority here).
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
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally','subscription',$2,$3::jsonb)`,
        [actorUserId, sub.id, JSON.stringify({ customerId, amountMinor: minor, currency, full: Boolean(full), reason: note, eventId, providerBacked: Boolean(providerBacked) })]);
    return { eventId, ended, amountMinor: minor, currency };
}

module.exports = { record, amountMinor };
