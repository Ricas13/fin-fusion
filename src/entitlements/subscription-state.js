'use strict';

const { query } = require('../db');

const LIVE_STATUSES = Object.freeze(['active','trialing','past_due','paused']);
const DIRECT_AUDIENCES = new Set(['direct','both']);
const RESELLER_AUDIENCES = new Set(['reseller','both']);

function recurringProvider(row) {
    const source = String(row?.source || '');
    const id = String(row?.provider_subscription_id || '');
    return (source === 'stripe' && /^sub_/i.test(id)) || (source === 'paypal' && /^I-/i.test(id));
}

function audienceAllows(plan, channel) {
    const audience = String(plan?.audience || 'direct');
    if (channel === 'customer') return DIRECT_AUDIENCES.has(audience);
    if (channel === 'reseller') return RESELLER_AUDIENCES.has(audience);
    return false;
}

function assertAudience(plan, channel) {
    if (!audienceAllows(plan, channel)) {
        throw new Error(channel === 'customer'
            ? 'This plan is not available for direct customers.'
            : 'This plan is not available through resellers.');
    }
    return plan;
}

/**
 * Resolve an already-purchased entitlement.
 *
 * IMPORTANT: plans.active/plans.visible are catalogue-sale controls. They must
 * never invalidate a paid-through subscription merely because an administrator
 * retired or hid the plan after sale. New acquisition paths enforce catalogue
 * availability before creating the subscription; this resolver intentionally
 * does not.
 */
async function effectiveSubscription(customerId, { client = null, includeBlocked = false } = {}) {
    const db = client || { query };
    const result = await db.query(`
        SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
               COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
               COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
               COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
               COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
               COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
               COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        WHERE s.customer_id=$1
          AND s.superseded_by IS NULL
          AND s.status IN ('active','trialing','past_due','paused')
          AND s.starts_at<=NOW()
          AND s.current_period_end>NOW()
          AND ($2::boolean OR c.access_paused_at IS NULL)
        ORDER BY
          CASE s.status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
          CASE
            WHEN s.source IN ('stripe','paypal') THEN 0
            WHEN s.source IN ('reseller_sale','reseller_credit') THEN 1
            WHEN s.source IN ('manual','admin_grant') THEN 2
            WHEN s.source='free_claim' THEN 3
            ELSE 4
          END,
          s.current_period_end DESC,s.created_at DESC
        LIMIT 1
    `, [customerId, Boolean(includeBlocked)]);
    return result.rows[0] || null;
}

async function assertNoOtherLiveRecurring(client, customerId, excludeId = null) {
    const result = await client.query(`
        SELECT id,source,provider_subscription_id,status,current_period_end
        FROM subscriptions
        WHERE customer_id=$1 AND superseded_by IS NULL
          AND id<>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
          AND source IN ('stripe','paypal')
          AND status IN ('active','trialing','past_due','paused')
          AND current_period_end>NOW()
          AND ((source='stripe' AND COALESCE(provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\')
            OR (source='paypal' AND COALESCE(provider_subscription_id,'') LIKE 'I-%'))
        LIMIT 1 FOR UPDATE
    `, [customerId, excludeId]);
    if (result.rowCount) throw new Error('A recurring subscription is already active for this customer. Change or cancel it instead of creating another one.');
}

function assertSafeSourceRewrite(existing, targetSource) {
    if (recurringProvider(existing) && !['stripe','paypal'].includes(String(targetSource || ''))) {
        throw new Error('A provider-managed recurring subscription cannot be converted into a manual or reseller subscription. Cancel/change provider billing through the billing workflow first.');
    }
}

async function markSuperseded(client, { subscriptionId, replacementId, reason = 'plan_change' }) {
    await client.query(`UPDATE subscriptions
        SET superseded_by=$2,replaced_at=NOW(),replacement_reason=$3,updated_at=NOW()
        WHERE id=$1 AND superseded_by IS NULL`, [subscriptionId, replacementId, String(reason || '').slice(0, 200)]);
}

module.exports = {
    LIVE_STATUSES,
    recurringProvider,
    audienceAllows,
    assertAudience,
    effectiveSubscription,
    assertNoOtherLiveRecurring,
    assertSafeSourceRewrite,
    markSuperseded
};
