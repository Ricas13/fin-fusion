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
    const summary = { total: result.rowCount, active: 0, suspended: 0, changed: 0, failed: 0 };
    for (const row of result.rows) {
        try {
            const entitlement = await monthly.resellerEntitlement(row.reseller_id);
            const outcome = await monthly.reconcileEstate(row.reseller_id);
            summary.changed += Number(outcome.changed || 0);
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
    const sync = await billing.syncDue({ limit: 100 });
    const tierChanges = typeof billing.applyDueTierChanges === 'function'
        ? await billing.applyDueTierChanges({ limit: 100 })
        : { total: 0, applied: 0, blocked: 0, awaiting_authorization: 0, failed: 0 };
    return {
        ...sync,
        processed: Number(sync.total || 0) + Number(tierChanges.total || 0),
        tierChanges
    };
}

module.exports = { reconcileSubscribedEstates, syncProviderSubscriptions };
