'use strict';

const { query } = require('../db');
const accessHolds = require('./access-holds');
const subscriptionState = require('./subscription-state');

const HOLD_TYPE = 'inactivity_policy';

async function releaseObsoleteForCustomer(customerId, actorUserId = null) {
    const holds = await query(`
        SELECT source_key,metadata,created_at
        FROM customer_access_holds
        WHERE customer_id=$1
          AND hold_type=$2
          AND released_at IS NULL
        ORDER BY created_at,id
    `, [customerId, HOLD_TYPE]);
    if (!holds.rowCount) return 0;

    // Do not duplicate Free-entitlement rules here. The canonical entitlement
    // reader already owns extensions, Permanent Access, admin authority and the
    // current plan identity. An inactivity hold stays valid only for that exact
    // live Free plan.
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(
        customerId,
        { includeBlocked: true }
    );
    const liveSourceKey = entitlement?.plan_id
        ? `plan:${entitlement.plan_id}`
        : null;
    const liveSubscriptionId = entitlement?.subscription_id
        ? String(entitlement.subscription_id)
        : null;
    const liveCreatedAt = entitlement?.subscription_created_at
        ? new Date(entitlement.subscription_created_at).getTime()
        : null;

    let released = 0;
    for (const hold of holds.rows) {
        const samePlan = Boolean(liveSourceKey && String(hold.source_key) === liveSourceKey);
        const heldSubscriptionId = hold?.metadata?.subscriptionId
            ? String(hold.metadata.subscriptionId)
            : null;
        const holdCreatedAt = new Date(hold.created_at).getTime();
        const sameEpisode = samePlan && (
            heldSubscriptionId
                ? heldSubscriptionId === liveSubscriptionId
                : Number.isFinite(liveCreatedAt)
                  && Number.isFinite(holdCreatedAt)
                  && holdCreatedAt >= liveCreatedAt
        );
        if (sameEpisode) continue;
        released += await accessHolds.releaseHold({
            customerId,
            type: HOLD_TYPE,
            sourceKey: hold.source_key,
            actorUserId,
            resolutionReason: 'Free entitlement no longer exists'
        });
    }
    return released;
}

module.exports = {
    HOLD_TYPE,
    releaseObsoleteForCustomer
};
