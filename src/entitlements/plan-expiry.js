'use strict';

const FREE_TIER_END_ISO = '9999-12-31T23:59:59.000Z';
const MAX_DURATION_DAYS = 3650;

function isFreeTier(plan) {
    return plan?.is_free_tier === true || String(plan?.is_free_tier || '').toLowerCase() === 'true';
}

function freeTierEnd() {
    return new Date(FREE_TIER_END_ISO);
}

function endForPlan(plan, { override = null, now = new Date() } = {}) {
    if (!plan) return null;
    if (isFreeTier(plan)) return freeTierEnd();

    if (override) {
        const parsed = new Date(override);
        if (Number.isNaN(parsed.getTime()) || parsed <= now) throw new Error('Subscription expiry must be in the future.');
        return parsed;
    }

    const rawDays = Number(plan.duration_days || 30);
    const days = Math.max(1, Math.min(Number.isFinite(rawDays) ? rawDays : 30, MAX_DURATION_DAYS));
    return new Date(now.getTime() + days * 86400000);
}

function visibleExpiry(plan, value) {
    return isFreeTier(plan) ? null : value || null;
}

module.exports = { FREE_TIER_END_ISO, isFreeTier, freeTierEnd, endForPlan, visibleExpiry };
