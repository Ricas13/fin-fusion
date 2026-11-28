'use strict';

const { transaction } = require('../db');

async function resolveAwaitingCheckout({ customerId, planId, provider = null, providerSubscriptionId = null, providerMappingId = null }) {
    if (!customerId || !planId) return null;
    return transaction(async client => {
        const result = await client.query(`
            UPDATE customer_plan_changes
               SET state='applied',
                   provider_schedule_state=COALESCE(provider_schedule_state,'customer_checkout'),
                   error=NULL,
                   updated_at=NOW()
             WHERE customer_id=$1
               AND target_plan_id=$2
               AND (provider='paypal' OR (provider='stripe' AND $3='stripe' AND provider_action_required AND target_price_id=$4 AND EXISTS(
                    SELECT 1 FROM subscriptions s WHERE s.customer_id=$1 AND s.plan_id=$2 AND s.source='stripe'
                    AND s.provider_subscription_id=$5 AND s.status='active' AND s.superseded_by IS NULL
                    AND s.provider_price_id_snapshot=$4 AND s.starts_at>=customer_plan_changes.effective_at)))
               AND state='awaiting_checkout'
             RETURNING *
        `, [customerId, planId, provider, providerMappingId, providerSubscriptionId]);
        const change = result.rows[0] || null;
        if (!change) return null;
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('customer.plan_change.checkout_completed','customer',$1,$2::jsonb)
        `, [customerId, JSON.stringify({
            changeId: change.id,
            targetPlanId: planId,
            fulfillmentProvider: provider,
            providerSubscriptionId
        })]);
        return change;
    });
}

module.exports = { resolveAwaitingCheckout };
