'use strict';

const { query } = require('../db');

function planId(plan) {
    return plan?.plan_id || plan?.id || null;
}

async function eligibleServersForPlan(plan, { enabledOnly = true } = {}) {
    if (!plan?.server_class) return [];
    const id = planId(plan);
    if (!id) {
        const result = await query(`
            SELECT * FROM jellyfin_servers
            WHERE server_class=$1 ${enabledOnly ? 'AND enabled=TRUE' : ''}
            ORDER BY priority,name
        `, [plan.server_class]);
        return result.rows;
    }

    const result = await query(`
        WITH restriction AS (
            SELECT EXISTS(
                SELECT 1
                FROM plan_server_eligibility pse
                JOIN jellyfin_servers restricted_server ON restricted_server.id=pse.server_id
                WHERE pse.plan_id=$2 AND restricted_server.server_class=$1
            ) AS restricted
        )
        SELECT js.*,pse.weight AS placement_weight
        FROM jellyfin_servers js
        CROSS JOIN restriction r
        LEFT JOIN plan_server_eligibility pse
               ON pse.plan_id=$2 AND pse.server_id=js.id
        WHERE js.server_class=$1
          ${enabledOnly ? 'AND js.enabled=TRUE' : ''}
          AND (NOT r.restricted OR pse.server_id IS NOT NULL)
        ORDER BY js.priority,js.name
    `, [plan.server_class, id]);
    return result.rows;
}

module.exports = { planId, eligibleServersForPlan };
