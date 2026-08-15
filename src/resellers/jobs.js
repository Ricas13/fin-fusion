'use strict';

const { query } = require('../db');
const monthly = require('./monthly');
const billing = require('../payments/reseller-billing');

async function reconcileSubscribedEstates() {
    // Upgrade safety: legacy credit-model resellers with no monthly subscription
    // row are deliberately untouched. Enforcement starts only after the reseller
    // has entered the monthly-tier model through provider checkout or an explicit
    // admin manual entitlement.
    const result = await query(`
        SELECT DISTINCT reseller_id
        FROM reseller_subscriptions
        ORDER BY reseller_id
    `);
    const summary = { total: result.rowCount, active: 0, suspended: 0, failed: 0 };
    for (const row of result.rows) {
        try {
            const entitlement = await monthly.resellerEntitlement(row.reseller_id);
            await monthly.reconcileEstate(row.reseller_id);
            if (entitlement.active) summary.active += 1;
            else summary.suspended += 1;
        } catch (error) {
            summary.failed += 1;
            console.error(`Monthly reseller estate reconcile failed for ${row.reseller_id}:`, error.message);
        }
    }
    return summary;
}

async function syncProviderSubscriptions() {
    return billing.syncDue({ limit: 100 });
}

module.exports = { reconcileSubscribedEstates, syncProviderSubscriptions };
