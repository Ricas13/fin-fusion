'use strict';

const AUTOMATION_ROLE = 'steamfusion_automation';
const AUTOMATION_ROLE_CONNECTION_LIMIT = 12;
const AUTOMATION_DEFAULT_PRIMARY_POOL_MAX = 6;
const AUTOMATION_DEFAULT_MAINTENANCE_LOCK_POOL_MAX = 4;
const AUTOMATION_DEFAULT_RECONCILIATION_MAX = 1;
const AUTOMATION_HEALTHCHECK_RESERVE = 1;

function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function databaseRole(connectionString) {
    try {
        return decodeURIComponent(new URL(String(connectionString || '')).username || '');
    } catch (_) {
        return '';
    }
}

function automationConnectionBudget(env = process.env) {
    const primaryPoolMax = boundedInteger(
        env.DB_POOL_SIZE,
        AUTOMATION_DEFAULT_PRIMARY_POOL_MAX,
        1,
        50
    );
    const reconciliationMax = boundedInteger(
        env.RECONCILIATION_MAX_CONCURRENCY,
        AUTOMATION_DEFAULT_RECONCILIATION_MAX,
        1,
        50
    );
    const explicitMaintenance = String(env.MAINTENANCE_LOCK_POOL_MAX || '').trim();
    const availableForMaintenance = AUTOMATION_ROLE_CONNECTION_LIMIT
        - primaryPoolMax
        - reconciliationMax
        - AUTOMATION_HEALTHCHECK_RESERVE;

    if (availableForMaintenance < 2) {
        throw new Error(
            `Unsafe automation database pool budget: DB_POOL_SIZE=${primaryPoolMax} and `
            + `RECONCILIATION_MAX_CONCURRENCY=${reconciliationMax} leave fewer than 2 maintenance-lock `
            + `connections under the ${AUTOMATION_ROLE_CONNECTION_LIMIT}-connection role limit.`
        );
    }

    const requestedMaintenance = boundedInteger(
        explicitMaintenance || AUTOMATION_DEFAULT_MAINTENANCE_LOCK_POOL_MAX,
        AUTOMATION_DEFAULT_MAINTENANCE_LOCK_POOL_MAX,
        2,
        32
    );
    if (explicitMaintenance && requestedMaintenance > availableForMaintenance) {
        throw new Error(
            `Unsafe automation maintenance-lock pool: MAINTENANCE_LOCK_POOL_MAX=${requestedMaintenance}, `
            + `DB_POOL_SIZE=${primaryPoolMax}, and RECONCILIATION_MAX_CONCURRENCY=${reconciliationMax} `
            + `exceed the ${AUTOMATION_ROLE_CONNECTION_LIMIT}-connection role budget.`
        );
    }

    const maintenanceLockPoolMax = Math.min(requestedMaintenance, availableForMaintenance);
    const totalReserved = primaryPoolMax
        + maintenanceLockPoolMax
        + reconciliationMax
        + AUTOMATION_HEALTHCHECK_RESERVE;

    return {
        role: AUTOMATION_ROLE,
        roleLimit: AUTOMATION_ROLE_CONNECTION_LIMIT,
        primaryPoolMax,
        maintenanceLockPoolMax,
        reconciliationMax,
        healthcheckReserve: AUTOMATION_HEALTHCHECK_RESERVE,
        totalReserved,
        spare: AUTOMATION_ROLE_CONNECTION_LIMIT - totalReserved
    };
}

module.exports = {
    AUTOMATION_ROLE,
    AUTOMATION_ROLE_CONNECTION_LIMIT,
    AUTOMATION_DEFAULT_PRIMARY_POOL_MAX,
    AUTOMATION_DEFAULT_MAINTENANCE_LOCK_POOL_MAX,
    AUTOMATION_DEFAULT_RECONCILIATION_MAX,
    AUTOMATION_HEALTHCHECK_RESERVE,
    boundedInteger,
    databaseRole,
    automationConnectionBudget
};
