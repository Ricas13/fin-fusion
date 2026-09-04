'use strict';

const { query } = require('../db');
const policy = require('./policy');
const provisioning = require('./provisioning');
const laneOverrides = require('./lane-policy-overrides');

async function scopedSelection(customerId, accountId) {
    if (accountId) {
        const scoped = await query(`
            SELECT selected_names
            FROM customer_jellyfin_library_selection
            WHERE customer_id=$1 AND jellyfin_account_id=$2
            LIMIT 1
        `, [customerId, accountId]);
        if (scoped.rowCount) return scoped.rows[0];
    }
    // Compatibility fallback for customers who already made one global choice
    // before selections became account/server scoped.
    return provisioning.getLibrarySelection(customerId);
}

async function setScopedSelection(customerId, accountId, names) {
    const owned = await query(`
        SELECT id
        FROM jellyfin_accounts
        WHERE id=$1 AND customer_id=$2 AND account_purpose='jellyfin'
        LIMIT 1
    `, [accountId, customerId]);
    if (!owned.rowCount) throw new Error('Jellyfin account not found');
    const clean = policy.normalizedNames(names).slice(0, 500).map(name => name.slice(0, 200));
    await query(`
        INSERT INTO customer_jellyfin_library_selection(customer_id,jellyfin_account_id,selected_names,updated_at)
        VALUES($1,$2,$3::text[],NOW())
        ON CONFLICT (customer_id,jellyfin_account_id)
        DO UPDATE SET selected_names=EXCLUDED.selected_names,updated_at=NOW()
    `, [customerId, accountId, clean]);
    return clean;
}

async function effectiveForAccount(customerId, plan, account) {
    if (!plan) return null;
    const serverId = account?.server_id || null;
    const accountId = account?.id || null;
    const accessLane = account?.access_lane || (plan?.is_free_tier ? 'free' : 'primary');
    const [override, libOverrides, selection] = await Promise.all([
        laneOverrides.getPolicyOverride(customerId, accessLane),
        provisioning.getLibraryOverrides(customerId, accessLane),
        scopedSelection(customerId, accountId)
    ]);
    const technicalRows = policy.effectiveTechnicalPolicy(plan, override);
    let catalog;
    if (serverId) {
        const folders = await provisioning.discoverServerLibraries(serverId);
        catalog = {
            names: folders.map(folder => folder.name).sort((a, b) => a.localeCompare(b)),
            failedServers: [],
            serverCount: 1
        };
    } else {
        catalog = await provisioning.libraryCatalogForPlan(plan);
    }
    const entitlementRows = policy.libraryEntitlement(plan, libOverrides, catalog.names);
    const visibleNames = policy.customerVisibleLibraries(entitlementRows, selection);
    const mode = ['all', 'exclude', 'include'].includes(plan?.library_access_mode) ? plan.library_access_mode : 'all';
    const unrestricted = mode === 'all' && libOverrides.length === 0 && !selection;
    return {
        accessLane,
        override,
        libOverrides,
        selection,
        technicalRows,
        technical: policy.flattenEffective(technicalRows),
        catalog,
        entitlementRows,
        visibleNames,
        unrestricted
    };
}

module.exports = { scopedSelection, setScopedSelection, effectiveForAccount };
