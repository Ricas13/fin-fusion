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

module.exports = { PRIMARY_SUBSCRIPTION_SQL, LIVE_AT_POINT_SQL, churnSummary, movementSummary };
