'use strict';

const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');

const ACCESS_STATES = Object.freeze({
    NONE: 'NONE',
    ACTIVE_READY: 'ACTIVE_READY',
    ACTIVE_BLOCKED: 'ACTIVE_BLOCKED',
    PAID_PROVISIONING_FAILED: 'PAID_PROVISIONING_FAILED',
    INCONSISTENT_UNPAID: 'INCONSISTENT_UNPAID',
    ORPHAN_ACCOUNT: 'ORPHAN_ACCOUNT'
});

function sameId(a, b) {
    return String(a || '') === String(b || '');
}

function laneOf(account) {
    return String(account?.access_lane || 'primary');
}

function accountMatchesEntitlement(account, entitlement, lane) {
    if (!account || !entitlement) return false;
    if (laneOf(account) !== lane) return false;
    if (account.disabled || !account.server_enabled) return false;
    return provisioning.accountMatchesEntitlementPlacement(account, entitlement);
}

function isTrial(entitlement) {
    return String(entitlement?.contract_billing_interval || entitlement?.billing_interval || '').toLowerCase() === 'trial';
}

function isPaid(entitlement) {
    const price = Number(entitlement?.contract_price_minor ?? entitlement?.price_minor ?? 0);
    return !isTrial(entitlement) && Number.isFinite(price) && price > 0;
}

async function accountsForCustomer(customerId, supplied = null) {
    return Array.isArray(supplied) ? supplied : provisioning.normalAccounts(customerId);
}

async function readyAccountForEntitlement(customerId, entitlement, lane, { accounts = null } = {}) {
    if (!entitlement || entitlement.blocked) return null;
    const rows = await accountsForCustomer(customerId, accounts);
    return rows.find(account => accountMatchesEntitlement(account, entitlement, lane)) || null;
}

async function freeJellyfin(customerId, { includeBlocked = true, accounts = null } = {}) {
    const [entitlement, rows] = await Promise.all([
        subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked }),
        accountsForCustomer(customerId, accounts)
    ]);
    const laneAccounts = rows.filter(account => laneOf(account) === 'free');
    if (!entitlement) {
        return {
            state: laneAccounts.length ? ACCESS_STATES.ORPHAN_ACCOUNT : ACCESS_STATES.NONE,
            entitlement: null,
            account: null,
            accounts: laneAccounts
        };
    }
    if (entitlement.blocked) {
        return {
            state: ACCESS_STATES.ACTIVE_BLOCKED,
            entitlement,
            account: null,
            accounts: laneAccounts
        };
    }
    const account = laneAccounts.find(row => accountMatchesEntitlement(row, entitlement, 'free')) || null;
    return {
        state: account ? ACCESS_STATES.ACTIVE_READY : ACCESS_STATES.INCONSISTENT_UNPAID,
        entitlement,
        account,
        accounts: laneAccounts
    };
}

async function primaryJellyfin(customerId, { includeBlocked = true, accounts = null } = {}) {
    const [rawEntitlement, rows] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { includeBlocked }),
        accountsForCustomer(customerId, accounts)
    ]);
    const entitlement = rawEntitlement?.is_free_tier ? null : rawEntitlement;
    const laneAccounts = rows.filter(account => laneOf(account) === 'primary');
    if (!entitlement) {
        return {
            state: laneAccounts.length ? ACCESS_STATES.ORPHAN_ACCOUNT : ACCESS_STATES.NONE,
            entitlement: null,
            account: null,
            accounts: laneAccounts
        };
    }
    if (entitlement.blocked) {
        return {
            state: ACCESS_STATES.ACTIVE_BLOCKED,
            entitlement,
            account: null,
            accounts: laneAccounts
        };
    }
    const account = laneAccounts.find(row => accountMatchesEntitlement(row, entitlement, 'primary')) || null;
    if (account) {
        return { state: ACCESS_STATES.ACTIVE_READY, entitlement, account, accounts: laneAccounts };
    }
    return {
        state: isPaid(entitlement) ? ACCESS_STATES.PAID_PROVISIONING_FAILED : ACCESS_STATES.INCONSISTENT_UNPAID,
        entitlement,
        account: null,
        accounts: laneAccounts
    };
}

async function snapshot(customerId) {
    const accounts = await provisioning.normalAccounts(customerId);
    const [primary, free] = await Promise.all([
        primaryJellyfin(customerId, { includeBlocked: true, accounts }),
        freeJellyfin(customerId, { includeBlocked: true, accounts })
    ]);
    return { customerId, primary, free };
}

module.exports = {
    ACCESS_STATES,
    sameId,
    laneOf,
    accountMatchesEntitlement,
    isTrial,
    isPaid,
    readyAccountForEntitlement,
    freeJellyfin,
    primaryJellyfin,
    snapshot
};
