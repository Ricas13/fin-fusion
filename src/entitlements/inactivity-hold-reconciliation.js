'use strict';

const { query } = require('../db');
const accessHolds = require('./access-holds');

const HOLD_TYPE = 'inactivity_policy';

// An inactivity hold means one thing: this live Free entitlement was removed
// for inactivity and stays removed until explicit restoration. The hold becomes
// obsolete only when that exact Free entitlement is no longer live.
async function releaseObsoleteForCustomer(customerId, actorUserId = null) {
    const holds = await query(`
        SELECT h.source_key
        FROM customer_access_holds h
        WHERE h.customer_id=$1
          AND h.hold_type=$2
          AND h.released_at IS NULL
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
    `, [customerId, HOLD_TYPE]);

    let released = 0;
    for (const hold of holds.rows) {
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

module.exports = { HOLD_TYPE, releaseObsoleteForCustomer };
