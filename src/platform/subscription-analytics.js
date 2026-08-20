'use strict';

const { query } = require('../db');

// One dashboard/business definition for primary-subscription movement.
// This intentionally excludes add-ons and superseded rows. “Cancellation” is
// the currently available approximation: a row whose current state is
// cancelled and whose updated_at falls inside the selected reporting window.
const PRIMARY_SUBSCRIPTION_SQL = `COALESCE(p.is_addon,FALSE)=FALSE AND s.superseded_by IS NULL`;
const LIVE_AT_POINT_SQL = `${PRIMARY_SUBSCRIPTION_SQL} AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<$1 AND s.current_period_end>$1`;

async function churnSummary(range) {
    const [cancelled, activeAtStart] = await Promise.all([
        query(`SELECT COUNT(*)::int n
               FROM subscriptions s JOIN plans p ON p.id=s.plan_id
               WHERE ${PRIMARY_SUBSCRIPTION_SQL}
                 AND s.status='cancelled' AND s.updated_at>=$1 AND s.updated_at<$2`, [range.start, range.end]),
        query(`SELECT COUNT(*)::int n
               FROM subscriptions s JOIN plans p ON p.id=s.plan_id
               WHERE ${LIVE_AT_POINT_SQL}`, [range.start])
    ]);
    const cancelledCount = Number(cancelled.rows[0]?.n || 0);
    const activeStart = Number(activeAtStart.rows[0]?.n || 0);
    return {
        cancelledCount,
        activeAtStart: activeStart,
        rate: activeStart ? (cancelledCount / activeStart * 100) : null
    };
}

async function movementSummary(range) {
    const result = await query(`
        SELECT
          COUNT(*) FILTER(WHERE s.created_at>=$1 AND s.created_at<$2)::int activations,
          COUNT(*) FILTER(WHERE s.status='cancelled' AND s.updated_at>=$1 AND s.updated_at<$2)::int cancellations,
          COUNT(*) FILTER(WHERE s.status='expired' AND s.updated_at>=$1 AND s.updated_at<$2)::int expirations
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${PRIMARY_SUBSCRIPTION_SQL}
    `, [range.start, range.end]);
    return result.rows[0] || { activations: 0, cancellations: 0, expirations: 0 };
}

// “Active customer” is an access concept, not a billing-status shortcut. Use
// the canonical effective primary-entitlement view so permanent extensions,
// holds/blocks and provider-state normalization are interpreted once.
async function effectivePrimarySummary(asOf = new Date(), { limit = null } = {}) {
    const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(1000, Number(limit)) : null;
    const [countResult, planResult] = await Promise.all([
        query(`SELECT COUNT(DISTINCT customer_id)::int n
               FROM effective_customer_entitlements
               WHERE blocked=FALSE AND access_expires_at>$1`, [asOf]),
        query(`SELECT p.id,p.name,p.code,p.service_type,COUNT(*)::int count
               FROM effective_customer_entitlements e
               JOIN plans p ON p.id=e.plan_id
               WHERE e.blocked=FALSE AND e.access_expires_at>$1
               GROUP BY p.id,p.name,p.code,p.service_type
               ORDER BY count DESC,p.name
               ${safeLimit ? 'LIMIT $2' : ''}`, safeLimit ? [asOf, safeLimit] : [asOf])
    ]);
    return { activeCustomers: Number(countResult.rows[0]?.n || 0), planMix: planResult.rows };
}

module.exports = { PRIMARY_SUBSCRIPTION_SQL, LIVE_AT_POINT_SQL, churnSummary, movementSummary, effectivePrimarySummary };
