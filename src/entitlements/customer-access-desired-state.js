'use strict';

function blockerState(holds) {
    return (Array.isArray(holds) ? holds : []).map(hold => ({
        id: hold?.id || null,
        type: hold?.hold_type || hold?.type || 'hold',
        sourceKey: hold?.source_key || hold?.sourceKey || null,
        reason: hold?.reason || null,
        createdAt: hold?.created_at || hold?.createdAt || null
    }));
}

function usable(entitlement) {
    return Boolean(entitlement && !entitlement.blocked);
}

function entitlementPlanId(entitlement) {
    return entitlement?.plan_id || entitlement?.planId || null;
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map(String))];
}

function deriveCustomerAccessDesiredState({
    effectiveJellyfin = null,
    freeEntitlement = null,
    stremioEntitlement = null,
    embyEntitlement = null,
    holds = []
} = {}) {
    const primaryEntitlement = effectiveJellyfin && !effectiveJellyfin.is_free_tier
        ? effectiveJellyfin
        : null;
    const blockers = blockerState(holds);
    const desired = {
        primaryJellyfin: usable(primaryEntitlement),
        freeJellyfin: usable(freeEntitlement),
        stremio: usable(stremioEntitlement),
        emby: usable(embyEntitlement)
    };
    const controlEntitlement = primaryEntitlement
        || freeEntitlement
        || stremioEntitlement
        || embyEntitlement
        || null;
    const activePlanIds = unique([
        desired.primaryJellyfin ? entitlementPlanId(primaryEntitlement) : null,
        desired.freeJellyfin ? entitlementPlanId(freeEntitlement) : null,
        desired.stremio ? entitlementPlanId(stremioEntitlement) : null,
        desired.emby ? entitlementPlanId(embyEntitlement) : null
    ]);

    return {
        primaryEntitlement,
        freeEntitlement,
        stremioEntitlement,
        embyEntitlement,
        controlEntitlement,
        blockers,
        desired,
        desiredAnyAccess: Object.values(desired).some(Boolean),
        activePlanIds
    };
}

module.exports = {
    blockerState,
    deriveCustomerAccessDesiredState
};
