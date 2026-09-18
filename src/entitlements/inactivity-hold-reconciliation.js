'use strict';

const { query } = require('../db');
const accessHolds = require('./access-holds');

const HOLD_TYPE = 'inactivity_policy';

async function releaseObsolete({ customerId = null, actorUserId = null } = {}) {
    const holds = await query(`
        SELECT h.customer_id,h.source_key
        FROM customer_access_holds h
        WHERE h.hold_type=$1
          AND h.released_at IS NULL
          AND ($2::uuid IS NULL OR h.customer_id=$2::uuid)
          AND NOT EXISTS(
            SELECT 1
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=h.customer_id
              AND ('plan:'||s.plan_id::text)=h.source_key
              AND s.superseded_by IS NULL
              AND s.status IN ('active','trialing','past_due','paused')
              AND s.starts_at<=NOW()
              AND s.current_period_end>NOW()
              AND p.is_free_tier=TRUE
              AND p.price_minor=0
              AND COALESCE(p.is_addon,FALSE)=FALSE
              AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
          )
    `, [HOLD_TYPE, customerId]);

    let released = 0;
    for (const hold of holds.rows) {
        released += await accessHolds.releaseHold({
            customerId: hold.customer_id,
            type: HOLD_TYPE,
            sourceKey: hold.source_key,
            actorUserId,
            resolutionReason: 'Free entitlement no longer exists'
        });
    }
    return released;
}

async function releaseObsoleteForCustomer(customerId, actorUserId = null) {
    return releaseObsolete({ customerId, actorUserId });
}

async function releaseObsoleteAll(actorUserId = null) {
    return releaseObsolete({ actorUserId });
}

module.exports = {
    HOLD_TYPE,
    releaseObsolete,
    releaseObsoleteForCustomer,
    releaseObsoleteAll
};
