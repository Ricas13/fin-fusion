'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const provisioning = require('../jellyfin/provisioning');

const POLICY_KEY = 'payment_risk_policy';
const DEFAULTS = Object.freeze({
    refundAction: 'preserve',
    disputeAction: 'suspend',
    chargebackAction: 'suspend',
    failedRenewalAction: 'provider_state'
});

function cleanAction(value, allowed, fallback) {
    return allowed.includes(String(value || '')) ? String(value) : fallback;
}
async function policy() {
    const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [POLICY_KEY]);
    const value = result.rows[0]?.setting_value || {};
    return {
        refundAction: cleanAction(value.refundAction, ['preserve','suspend'], DEFAULTS.refundAction),
        disputeAction: cleanAction(value.disputeAction, ['preserve','suspend'], DEFAULTS.disputeAction),
        chargebackAction: cleanAction(value.chargebackAction, ['preserve','suspend'], DEFAULTS.chargebackAction),
        failedRenewalAction: 'provider_state'
    };
}
async function savePolicy(input, actorUserId = null) {
    const value = {
        refundAction: cleanAction(input.refundAction, ['preserve','suspend'], DEFAULTS.refundAction),
        disputeAction: cleanAction(input.disputeAction, ['preserve','suspend'], DEFAULTS.disputeAction),
        chargebackAction: cleanAction(input.chargebackAction, ['preserve','suspend'], DEFAULTS.chargebackAction),
        failedRenewalAction: 'provider_state'
    };
    await transaction(async client => {
        await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [POLICY_KEY, JSON.stringify(value)]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.payment_risk_policy.update','platform_setting',$2,$3::jsonb)`, [actorUserId,POLICY_KEY,JSON.stringify(value)]);
    });
    return value;
}

async function identityFromProviderSubscription(provider, providerSubscriptionId) {
    if (!providerSubscriptionId) return { scope: 'unresolved', customerId: null, resellerId: null };
    const direct = await query(`SELECT customer_id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 ORDER BY created_at DESC LIMIT 1`, [provider,providerSubscriptionId]);
    if (direct.rowCount) return { scope: 'direct', customerId: direct.rows[0].customer_id, resellerId: null };
    const reseller = await query(`SELECT reseller_id FROM reseller_subscriptions WHERE source=$1 AND provider_subscription_id=$2 ORDER BY created_at DESC LIMIT 1`, [provider,providerSubscriptionId]);
    if (reseller.rowCount) return { scope: 'reseller', customerId: null, resellerId: reseller.rows[0].reseller_id };
    return { scope: 'unresolved', customerId: null, resellerId: null };
}
async function identityFromMetadata(metadata = {}) {
    if (metadata.internal_customer_id) return { scope: 'direct', customerId: metadata.internal_customer_id, resellerId: null };
    if (metadata.internal_reseller_id) return { scope: 'reseller', customerId: null, resellerId: metadata.internal_reseller_id };
    return { scope: 'unresolved', customerId: null, resellerId: null };
}
async function resellerCustomerIds(resellerId) {
    const result = await query(`SELECT DISTINCT c.id FROM customers c LEFT JOIN resellers r ON r.id=$1
        WHERE c.reseller_id=$1 OR c.id=r.own_customer_id ORDER BY c.id`, [resellerId]);
    return result.rows.map(row => row.id);
}
async function reconcileMany(ids) {
    for (const id of ids) {
        try { await provisioning.reconcileCustomer(id); }
        catch (error) { console.warn(`Payment incident reconcile failed for customer ${id}:`, error.message); }
    }
}
function holdSource(provider, caseId) { return `${provider}:${String(caseId || '').slice(0,170)}`; }
async function applyHold(identity, provider, caseId, reason) {
    const sourceKey = holdSource(provider, caseId), ids = identity.scope === 'direct' && identity.customerId
        ? [identity.customerId]
        : identity.scope === 'reseller' && identity.resellerId ? await resellerCustomerIds(identity.resellerId) : [];
    for (const customerId of ids) {
        await accessHolds.addHold({ customerId, type: 'payment_risk', sourceKey, reason, metadata: { provider, caseId, scope: identity.scope } });
    }
    await reconcileMany(ids);
    return ids.length;
}
async function releaseHold(identity, provider, caseId) {
    const sourceKey = holdSource(provider, caseId), ids = identity.scope === 'direct' && identity.customerId
        ? [identity.customerId]
        : identity.scope === 'reseller' && identity.resellerId ? await resellerCustomerIds(identity.resellerId) : [];
    for (const customerId of ids) await accessHolds.releaseHold({ customerId, type: 'payment_risk', sourceKey });
    await reconcileMany(ids);
    return ids.length;
}

function policyAction(kind, cfg) {
    if (kind === 'refund') return cfg.refundAction;
    if (kind === 'dispute') return cfg.disputeAction;
    if (kind === 'chargeback') return cfg.chargebackAction;
    return cfg.failedRenewalAction;
}

async function record({ provider, eventId, caseId = null, kind, status = 'open', identity = null,
    providerSubscriptionId = null, amountMinor = null, currency = null, metadata = {} }) {
    if (!['stripe','paypal'].includes(provider)) throw new Error('Unsupported incident provider.');
    if (!['refund','dispute','chargeback','failed_renewal'].includes(kind)) throw new Error('Unsupported payment incident type.');
    const resolvedIdentity = identity || await identityFromProviderSubscription(provider, providerSubscriptionId);
    const cfg = await policy();
    let action = policyAction(kind, cfg);
    if (['resolved','won'].includes(status)) action = 'restore';
    if (status === 'recorded' && kind === 'refund' && action !== 'suspend') action = 'preserve';

    const inserted = await query(`INSERT INTO payment_incidents(
        provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,reseller_id,
        provider_subscription_id,amount_minor,currency,access_action,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT(provider,provider_event_id,incident_type) DO NOTHING RETURNING *`, [
        provider,String(eventId),caseId?String(caseId):null,kind,status,resolvedIdentity.scope||'unresolved',
        resolvedIdentity.customerId||null,resolvedIdentity.resellerId||null,providerSubscriptionId||null,
        amountMinor==null?null:Number(amountMinor),currency?String(currency).toUpperCase().slice(0,3):null,
        action,JSON.stringify(metadata||{})
    ]);
    if (!inserted.rowCount) return { duplicate: true };

    let affected = 0;
    if (action === 'suspend' && caseId && resolvedIdentity.scope !== 'unresolved') {
        affected = await applyHold(resolvedIdentity, provider, caseId, `${provider} ${kind} is under review`);
    } else if (action === 'restore' && caseId) {
        let restoreIdentity = resolvedIdentity;
        if (restoreIdentity.scope === 'unresolved') {
            const prior = await query(`SELECT scope,customer_id,reseller_id FROM payment_incidents
                WHERE provider=$1 AND provider_case_id=$2 AND access_action='suspend' ORDER BY created_at LIMIT 1`, [provider,String(caseId)]);
            if (prior.rowCount) restoreIdentity = { scope: prior.rows[0].scope, customerId: prior.rows[0].customer_id, resellerId: prior.rows[0].reseller_id };
        }
        if (restoreIdentity.scope !== 'unresolved') affected = await releaseHold(restoreIdentity, provider, caseId);
    }
    return { duplicate: false, incident: inserted.rows[0], affected };
}

async function recent(limit = 100) {
    const result = await query(`SELECT pi.*,c.display_name customer_name,u.username reseller_name
        FROM payment_incidents pi LEFT JOIN customers c ON c.id=pi.customer_id
        LEFT JOIN resellers r ON r.id=pi.reseller_id LEFT JOIN app_users u ON u.id=r.user_id
        ORDER BY pi.created_at DESC LIMIT $1`, [Math.max(1,Math.min(500,Number(limit)||100))]);
    return result.rows;
}

module.exports = { policy, savePolicy, record, recent, identityFromProviderSubscription, identityFromMetadata, holdSource };
