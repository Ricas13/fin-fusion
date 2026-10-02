'use strict';

const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');

const ACCESS_STATES = Object.freeze({
    NONE: 'NONE',
    ACTIVE_READY: 'ACTIVE_READY',
    ACTIVE_BLOCKED: 'ACTIVE_BLOCKED',
    PAID_PROVISIONING_FAILED: 'PAID_PROVISIONING_FAILED',
    INCONSISTENT_UNPAID: 'INCONSISTENT_UNPAID',
    ORPHAN_ACCOUNT: 'ORPHAN_ACCOUNT',
    ACTIVE_ENTITLED: 'ACTIVE_ENTITLED'
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

function operatorProtected(entitlement) {
    if (!entitlement) return false;
    if (entitlement.permanent_access) return true;
    const mode = String(entitlement.admin_jellyfin_mode || '').toLowerCase();
    if (mode) return mode === 'present';
    return Boolean(entitlement.admin_present);
}

async function accountsForCustomer(customerId, supplied = null) {
    return Array.isArray(supplied) ? supplied : provisioning.normalAccounts(customerId);
}

async function readyAccountForEntitlement(customerId, entitlement, lane, { accounts = null } = {}) {
    if (!entitlement || entitlement.blocked) return null;
    const rows = await accountsForCustomer(customerId, accounts);
    return rows.find(account => accountMatchesEntitlement(account, entitlement, lane)) || null;
}

function classifyLane({ entitlement = null, accounts = [], lane, paidMissing = false } = {}) {
    const laneAccounts = (Array.isArray(accounts) ? accounts : []).filter(account => laneOf(account) === lane);
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
    const account = laneAccounts.find(row => accountMatchesEntitlement(row, entitlement, lane)) || null;
    if (account) {
        return { state: ACCESS_STATES.ACTIVE_READY, entitlement, account, accounts: laneAccounts };
    }
    return {
        state: paidMissing && isPaid(entitlement)
            ? ACCESS_STATES.PAID_PROVISIONING_FAILED
            : ACCESS_STATES.INCONSISTENT_UNPAID,
        entitlement,
        account: null,
        accounts: laneAccounts
    };
}

async function freeJellyfin(customerId, { includeBlocked = true, accounts = null } = {}) {
    const [entitlement, rows] = await Promise.all([
        subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked }),
        accountsForCustomer(customerId, accounts)
    ]);
    return classifyLane({ entitlement, accounts: rows, lane: 'free', paidMissing: false });
}

async function primaryJellyfin(customerId, { includeBlocked = true, accounts = null } = {}) {
    const [rawEntitlement, rows] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { includeBlocked }),
        accountsForCustomer(customerId, accounts)
    ]);
    const entitlement = rawEntitlement?.is_free_tier ? null : rawEntitlement;
    return classifyLane({ entitlement, accounts: rows, lane: 'primary', paidMissing: true });
}

async function serviceEntitlement(customerId, service, { includeBlocked = true } = {}) {
    const normalized = String(service || '').trim().toLowerCase();
    let entitlement = null;
    if (normalized === 'emby') {
        entitlement = await subscriptionState.effectiveEmbySubscription(customerId, { includeBlocked });
    } else if (normalized === 'stremio') {
        entitlement = await subscriptionState.effectiveStremioSubscription(customerId, { includeBlocked });
    } else {
        throw new Error(`Unsupported canonical service access state: ${normalized || '(empty)'}`);
    }
    if (!entitlement) return { state: ACCESS_STATES.NONE, entitlement: null };
    if (entitlement.blocked) return { state: ACCESS_STATES.ACTIVE_BLOCKED, entitlement };
    return { state: ACCESS_STATES.ACTIVE_ENTITLED, entitlement };
}

async function emby(customerId, options = {}) {
    return serviceEntitlement(customerId, 'emby', options);
}

async function stremio(customerId, options = {}) {
    return serviceEntitlement(customerId, 'stremio', options);
}

async function snapshot(customerId, { includeBlocked = {} } = {}) {
    const blocked = {
        primary: includeBlocked.primary ?? true,
        free: includeBlocked.free ?? true,
        emby: includeBlocked.emby ?? true,
        stremio: includeBlocked.stremio ?? true
    };
    const accounts = await provisioning.normalAccounts(customerId);
    const [primary, free, embyAccess, stremioAccess] = await Promise.all([
        primaryJellyfin(customerId, { includeBlocked: blocked.primary, accounts }),
        freeJellyfin(customerId, { includeBlocked: blocked.free, accounts }),
        emby(customerId, { includeBlocked: blocked.emby }),
        stremio(customerId, { includeBlocked: blocked.stremio })
    ]);
    return { customerId, primary, free, emby: embyAccess, stremio: stremioAccess };
}

module.exports = {
    ACCESS_STATES,
    sameId,
    laneOf,
    accountMatchesEntitlement,
    isTrial,
    isPaid,
    operatorProtected,
    readyAccountForEntitlement,
    classifyLane,
    freeJellyfin,
    primaryJellyfin,
    serviceEntitlement,
    emby,
    stremio,
    snapshot
};
