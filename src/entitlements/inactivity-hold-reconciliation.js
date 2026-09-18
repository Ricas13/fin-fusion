'use strict';

const { query } = require('../db');
const accessHolds = require('./access-holds');
const subscriptionState = require('./subscription-state');

const HOLD_TYPE = 'inactivity_policy';

async function releaseObsoleteForCustomer(customerId, actorUserId = null) {
    const holds = await query(`
        SELECT source_key
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

    let released = 0;
    for (const hold of holds.rows) {
        if (liveSourceKey && String(hold.source_key) === liveSourceKey) continue;
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

async function releaseObsoleteAll(actorUserId = null) {
    const customers = await query(`
        SELECT DISTINCT customer_id
        FROM customer_access_holds
        WHERE hold_type=$1
          AND released_at IS NULL
        ORDER BY customer_id
    `, [HOLD_TYPE]);

    let released = 0;
    for (const row of customers.rows) {
        released += await releaseObsoleteForCustomer(row.customer_id, actorUserId);
    }
    return released;
}

module.exports = {
    HOLD_TYPE,
    releaseObsoleteForCustomer,
    releaseObsoleteAll
};
