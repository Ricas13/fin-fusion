'use strict';

const { query } = require('../db');
const providerSettings = require('./provider-settings');

async function jsonFetch(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(body?.error?.message || body?.message || `Provider returned HTTP ${response.status}`);
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

function idOf(value) {
    if (typeof value === 'string') return value;
    return value?.id || null;
}

function stripeReference(event) {
    const obj = event?.data?.object || {};
    const candidates = [
        obj.subscription,
        obj.subscription_details?.subscription,
        obj.parent?.subscription_details?.subscription,
        obj.id
    ].map(idOf);
    return candidates.find(value => typeof value === 'string' && value.startsWith('sub_')) || null;
}

function stripeInvoiceReference(invoice) {
    const candidates = [
        invoice?.subscription,
        invoice?.subscription_details?.subscription,
        invoice?.parent?.subscription_details?.subscription
    ].map(idOf);
    return candidates.find(value => typeof value === 'string' && value.startsWith('sub_')) || null;
}

async function stripeKey() {
    const cfg = await providerSettings.getRaw('stripe');
    const key = cfg.restrictedKey || cfg.apiKey;
    if (!key) throw new Error('Stripe credentials are not configured.');
    return key;
}

async function stripeGet(key, path) {
    return jsonFetch(`https://api.stripe.com${path}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
}

async function stripeEvent(eventId, key = null) {
    const authKey = key || await stripeKey();
    const event = await stripeGet(authKey, `/v1/events/${encodeURIComponent(eventId)}`);
    const obj = event?.data?.object || {};
    return {
        event,
        reference: stripeReference(event),
        eventType: event.type || null,
        objectId: obj.id || null,
        providerStatus: obj.status || null,
        providerOutcome: obj.outcome?.type || obj.outcome || null
    };
}

async function stripeReferenceFromDispute(key, dispute) {
    const chargeId = idOf(dispute?.charge);
    if (!chargeId) return null;
    const charge = typeof dispute?.charge === 'object'
        ? dispute.charge
        : await stripeGet(key, `/v1/charges/${encodeURIComponent(chargeId)}`);
    const invoiceId = idOf(charge?.invoice);
    if (!invoiceId) return null;
    const invoice = typeof charge?.invoice === 'object'
        ? charge.invoice
        : await stripeGet(key, `/v1/invoices/${encodeURIComponent(invoiceId)}`);
    return stripeInvoiceReference(invoice);
}

async function stripeCurrentState(incident) {
    const key = await stripeKey();
    let event = null;
    try {
        if (incident.provider_event_id) event = await stripeEvent(incident.provider_event_id, key);
    } catch (_) {
        // Current provider resources are authoritative for reconciliation. Older
        // event objects can age out of provider retention, so they are only a
        // provenance/reference fallback here.
    }

    if (['dispute', 'chargeback'].includes(incident.incident_type)) {
        if (!incident.provider_case_id) throw new Error('This incident has no Stripe dispute ID to verify.');
        const dispute = await stripeGet(key, `/v1/disputes/${encodeURIComponent(incident.provider_case_id)}`);
        const reference = await stripeReferenceFromDispute(key, dispute)
            || event?.reference
            || incident.provider_subscription_id
            || null;
        const status = String(dispute.status || '').toLowerCase();
        return {
            reference,
            eventType: event?.eventType || null,
            objectId: dispute.id || incident.provider_case_id,
            providerStatus: status || null,
            providerOutcome: status || null,
            currentResource: 'dispute',
            restoreEligible: status === 'won',
            eventVerified: Boolean(event)
        };
    }

    if (incident.incident_type === 'failed_renewal') {
        const reference = incident.provider_subscription_id || event?.reference || null;
        if (!reference || !String(reference).startsWith('sub_')) {
            throw new Error('This incident has no Stripe subscription ID to verify.');
        }
        const subscription = await stripeGet(
            key,
            `/v1/subscriptions/${encodeURIComponent(reference)}?expand%5B%5D=latest_invoice`
        );
        const latestInvoice = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null;
        const subscriptionStatus = String(subscription.status || '').toLowerCase();
        const invoiceStatus = String(latestInvoice?.status || '').toLowerCase();
        const healthy = subscriptionStatus === 'active' && invoiceStatus === 'paid';
        return {
            reference,
            eventType: event?.eventType || null,
            objectId: subscription.id || reference,
            providerStatus: healthy ? 'paid' : (subscriptionStatus || invoiceStatus || null),
            providerOutcome: invoiceStatus ? `latest_invoice:${invoiceStatus}` : null,
            currentResource: 'subscription',
            restoreEligible: healthy,
            eventVerified: Boolean(event),
            subscriptionStatus: subscriptionStatus || null,
            latestInvoiceStatus: invoiceStatus || null,
            latestInvoiceId: idOf(subscription.latest_invoice)
        };
    }

    // Refund incidents are intentionally never allowed to restore access by a
    // local override. Re-fetching their provider event is still useful for the
    // reconciliation/audit trail.
    if (!event && incident.provider_event_id) event = await stripeEvent(incident.provider_event_id, key);
    return {
        reference: event?.reference || incident.provider_subscription_id || null,
        eventType: event?.eventType || null,
        objectId: event?.objectId || incident.provider_case_id || null,
        providerStatus: event?.providerStatus || null,
        providerOutcome: event?.providerOutcome || null,
        currentResource: 'event',
        restoreEligible: false,
        eventVerified: Boolean(event)
    };
}

async function paypalAuth() {
    const cfg = await providerSettings.getRaw('paypal');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal credentials are not configured.');
    const host = cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const token = await jsonFetch(`${host}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: 'grant_type=client_credentials'
    });
    if (!token.access_token) throw new Error('PayPal did not return an access token.');
    return { host, token: token.access_token };
}

async function paypalGet(auth, path) {
    return jsonFetch(`${auth.host}${path}`, {
        headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' }
    });
}

function paypalReference(event) {
    const resource = event?.resource || {};
    const candidates = [
        resource.billing_agreement_id,
        resource.supplementary_data?.related_ids?.subscription_id,
        resource.id
    ].map(idOf);
    return candidates.find(value => typeof value === 'string' && value.startsWith('I-')) || null;
}

async function paypalEvent(eventId, auth = null) {
    const session = auth || await paypalAuth();
    const event = await paypalGet(session, `/v1/notifications/webhooks-events/${encodeURIComponent(eventId)}`);
    const resource = event?.resource || {};
    return {
        event,
        reference: paypalReference(event),
        eventType: event.event_type || null,
        objectId: resource.id || null,
        providerStatus: resource.status || null,
        providerOutcome: resource.dispute_outcome?.outcome_code
            || resource.dispute_outcome?.outcome
            || resource.outcome_code
            || null
    };
}

function paypalMerchantWon(outcome) {
    const normalized = String(outcome || '').toUpperCase();
    return [
        'RESOLVED_SELLER_FAVOR',
        'RESOLVED_SELLER_FAVOUR',
        'RESOLVED_WITH_PAYOUT',
        'CANCELED_BY_BUYER',
        'CANCELLED_BY_BUYER',
        'DENIED'
    ].includes(normalized);
}

async function paypalCurrentState(incident) {
    const auth = await paypalAuth();
    let event = null;
    try {
        if (incident.provider_event_id) event = await paypalEvent(incident.provider_event_id, auth);
    } catch (_) {
        // See the Stripe path: current provider state is the restore authority;
        // the original webhook event is only a fallback for old references.
    }

    if (['dispute', 'chargeback'].includes(incident.incident_type)) {
        if (!incident.provider_case_id) throw new Error('This incident has no PayPal dispute ID to verify.');
        const dispute = await paypalGet(auth, `/v1/customer/disputes/${encodeURIComponent(incident.provider_case_id)}`);
        const status = String(dispute.status || '').toLowerCase();
        const outcome = dispute.dispute_outcome?.outcome_code
            || dispute.dispute_outcome?.outcome
            || dispute.outcome_code
            || null;
        const merchantWon = paypalMerchantWon(outcome);
        return {
            reference: event?.reference || incident.provider_subscription_id || null,
            eventType: event?.eventType || null,
            objectId: dispute.dispute_id || dispute.id || incident.provider_case_id,
            providerStatus: status || null,
            providerOutcome: outcome,
            currentResource: 'dispute',
            restoreEligible: status === 'resolved' && merchantWon,
            eventVerified: Boolean(event)
        };
    }

    if (incident.incident_type === 'failed_renewal') {
        const reference = incident.provider_subscription_id || event?.reference || null;
        if (!reference || !String(reference).startsWith('I-')) {
            throw new Error('This incident has no PayPal subscription ID to verify.');
        }
        const subscription = await paypalGet(
            auth,
            `/v1/billing/subscriptions/${encodeURIComponent(reference)}?fields=last_failed_payment`
        );
        const status = String(subscription.status || '').toLowerCase();
        const failedPayments = Number(subscription.billing_info?.failed_payments_count);
        const healthy = status === 'active' && Number.isFinite(failedPayments) && failedPayments === 0;
        return {
            reference,
            eventType: event?.eventType || null,
            objectId: subscription.id || reference,
            providerStatus: status || null,
            providerOutcome: Number.isFinite(failedPayments) ? `failed_payments:${failedPayments}` : null,
            currentResource: 'subscription',
            restoreEligible: healthy,
            eventVerified: Boolean(event),
            failedPaymentsCount: Number.isFinite(failedPayments) ? failedPayments : null,
            lastPaymentTime: subscription.billing_info?.last_payment?.time || null
        };
    }

    if (!event && incident.provider_event_id) event = await paypalEvent(incident.provider_event_id, auth);
    return {
        reference: event?.reference || incident.provider_subscription_id || null,
        eventType: event?.eventType || null,
        objectId: event?.objectId || incident.provider_case_id || null,
        providerStatus: event?.providerStatus || null,
        providerOutcome: event?.providerOutcome || null,
        currentResource: 'event',
        restoreEligible: false,
        eventVerified: Boolean(event)
    };
}

async function localMatch(provider, reference) {
    if (!reference) return null;
    const direct = await query(`
        SELECT 'customer' scope,customer_id owner_id,id subscription_id,status,current_period_end
        FROM subscriptions
        WHERE source=$1 AND provider_subscription_id=$2
        ORDER BY created_at DESC LIMIT 1
    `, [provider, reference]);
    if (direct.rowCount) return direct.rows[0];
    const reseller = await query(`
        SELECT 'reseller' scope,reseller_id owner_id,id subscription_id,status,current_period_end
        FROM reseller_subscriptions
        WHERE source=$1 AND provider_subscription_id=$2
        ORDER BY created_at DESC LIMIT 1
    `, [provider, reference]);
    return reseller.rows[0] || null;
}

function assertMatchIdentity(incident, match) {
    if (!match) return;
    if (incident.scope === 'direct' && incident.customer_id) {
        if (match.scope !== 'customer' || String(match.owner_id) !== String(incident.customer_id)) {
            throw new Error('Provider reconciliation matched a different customer than this incident.');
        }
    }
    if (incident.scope === 'reseller' && incident.reseller_id) {
        if (match.scope !== 'reseller' || String(match.owner_id) !== String(incident.reseller_id)) {
            throw new Error('Provider reconciliation matched a different reseller than this incident.');
        }
    }
}

async function reconcile(incidentId, actorUserId = null) {
    const incident = (await query('SELECT * FROM payment_incidents WHERE id=$1', [incidentId])).rows[0];
    if (!incident) throw new Error('Payment incident not found.');

    const current = incident.provider === 'stripe'
        ? await stripeCurrentState(incident)
        : incident.provider === 'paypal'
            ? await paypalCurrentState(incident)
            : (() => { throw new Error('Unsupported provider.'); })();

    const reference = current.reference || incident.provider_subscription_id || null;
    const match = await localMatch(incident.provider, reference);
    assertMatchIdentity(incident, match);

    const snapshot = {
        reconciledAt: new Date().toISOString(),
        currentResource: current.currentResource || null,
        eventVerified: Boolean(current.eventVerified),
        eventType: current.eventType || null,
        providerObjectId: current.objectId || null,
        providerStatus: current.providerStatus || null,
        providerOutcome: current.providerOutcome || null,
        restoreEligible: current.restoreEligible === true,
        subscriptionReference: reference,
        subscriptionStatus: current.subscriptionStatus || null,
        latestInvoiceStatus: current.latestInvoiceStatus || null,
        latestInvoiceId: current.latestInvoiceId || null,
        failedPaymentsCount: current.failedPaymentsCount ?? null,
        lastPaymentTime: current.lastPaymentTime || null,
        matchedScope: match?.scope || null,
        matchedSubscriptionId: match?.subscription_id || null,
        matchedStatus: match?.status || null,
        matchedPeriodEnd: match?.current_period_end || null
    };

    await query(`
        UPDATE payment_incidents
        SET customer_id=COALESCE($2,customer_id),
            reseller_id=COALESCE($3,reseller_id),
            provider_subscription_id=COALESCE($4,provider_subscription_id),
            provider_object_id=COALESCE($5,provider_object_id),
            metadata=COALESCE(metadata,'{}'::jsonb)||$6::jsonb,
            updated_at=NOW()
        WHERE id=$1
    `, [
        incidentId,
        match?.scope === 'customer' ? match.owner_id : null,
        match?.scope === 'reseller' ? match.owner_id : null,
        reference,
        current.objectId || null,
        JSON.stringify({ providerReconciliation: snapshot })
    ]);

    const note = match
        ? `Provider current-state verification matched ${match.scope} subscription ${match.subscription_id}; provider status ${snapshot.providerStatus || 'unknown'}; restore ${snapshot.restoreEligible ? 'eligible' : 'not eligible'}.`
        : `Provider current-state verification completed but no local subscription matched reference ${reference || 'none'}; restore is not eligible.`;
    await query('INSERT INTO payment_incident_notes(incident_id,actor_user_id,note) VALUES($1,$2,$3)', [incidentId, actorUserId, note]);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'admin.payment_incident.reconcile','payment_incident',$2,$3::jsonb)
    `, [actorUserId, incidentId, JSON.stringify(snapshot)]);

    return { incidentId, match, reference, snapshot };
}

module.exports = {
    reconcile,
    localMatch,
    stripeReference,
    paypalReference,
    paypalMerchantWon,
    stripeCurrentState,
    paypalCurrentState,
    assertMatchIdentity
};
