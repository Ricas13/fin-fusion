'use strict';

const { query } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const mediaReconciliation = require('../jellyfin/media-service-reconciliation');
const stremio = require('../stremio/entitlements');
const subscriptionState = require('../entitlements/subscription-state');
const discordRoles = require('../integrations/discord-roles');

function clean(error) {
    return String(error?.message || error || 'Unknown service recovery failure')
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .slice(0, 700);
}

async function dueCustomers({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await query(`
        SELECT customer_id,status,last_error,next_attempt_at,updated_at
        FROM customer_provisioning_state
        WHERE status IN ('failed','blocked')
        ORDER BY COALESCE(next_attempt_at,updated_at),updated_at
        LIMIT $1
    `, [safeLimit]);
    return result.rows;
}

async function recoverCustomer(customerId) {
    return provisioning.reconciliationLock.withCustomerReconciliationLock(customerId, async () => {
        const outcomes = {};
        const failures = [];
        const capture = async (name, fn) => {
            try { outcomes[name] = await fn(); }
            catch (error) { failures.push({ service: name, error: clean(error) }); outcomes[name] = null; }
        };

        await capture('stremio', async () => {
            const entitlement = await stremio.entitledSubscription(customerId);
            if (entitlement) return stremio.reconcileForCustomer(customerId, entitlement);
            await stremio.suspend(customerId, 'No current Stremio subscription.');
            return { status: 'inactive' };
        });

        await capture('emby', () => mediaReconciliation.reconcileCustomer(customerId, 'emby'));

        await capture('discord', async () => {
            const activePlanIds = await provisioning.activeDiscordPlanIds(customerId);
            const result = await discordRoles.syncRoleForCustomer(customerId, activePlanIds);
            return provisioning.assertDiscordSyncResult(result);
        });

        // Do not mark the customer healthy here. The canonical full reconciliation
        // remains authoritative and may still have a broken Jellyfin lane. This
        // recovery pass only prevents an unrelated service from being stranded
        // behind that failure.
        return { customerId, outcomes, failures };
    });
}

async function run({ limit = 100 } = {}) {
    const rows = await dueCustomers({ limit });
    const summary = { total: rows.length, processed: rows.length, recoveredServices: 0, failed: 0, customerFailures: [] };
    for (const row of rows) {
        try {
            const result = await recoverCustomer(row.customer_id);
            summary.recoveredServices += Object.values(result.outcomes).filter(Boolean).length;
            if (result.failures.length) {
                summary.failed += result.failures.length;
                summary.customerFailures.push({ customerId: row.customer_id, failures: result.failures });
            }
        } catch (error) {
            summary.failed++;
            summary.customerFailures.push({ customerId: row.customer_id, failures: [{ service: 'recovery_lock', error: clean(error) }] });
        }
    }
    if (summary.failed) {
        summary.warning = `${summary.failed} independent service recovery attempt${summary.failed === 1 ? '' : 's'} failed: ${summary.customerFailures.slice(0, 3).flatMap(x => x.failures).map(x => `${x.service}: ${x.error}`).join('; ')}`.slice(0, 1000);
    }
    return summary;
}

module.exports = { clean, dueCustomers, recoverCustomer, run };
