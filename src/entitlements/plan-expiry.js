'use strict';

const billingPeriods = require('../payments/billing-periods');

const FREE_TIER_END_ISO = '9999-12-31T23:59:59.000Z';
const MAX_DURATION_DAYS = 3650;

function isFreeTier(plan) {
    return plan?.is_free_tier === true || String(plan?.is_free_tier || '').toLowerCase() === 'true';
}

function freeTierEnd() {
    return new Date(FREE_TIER_END_ISO);
}

function parseOverride(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw);
}

function endForPlan(plan, { override = null, now = new Date() } = {}) {
    if (!plan) return null;
    if (isFreeTier(plan)) return freeTierEnd();

    if (override) {
        const parsed = parseOverride(override);
        if (!parsed || Number.isNaN(parsed.getTime()) || parsed <= now) throw new Error('Subscription expiry must be in the future.');
        return parsed;
    }

    const interval = String(plan.billing_interval || plan.billingInterval || '').toLowerCase();
    if (['month','6_months','year'].includes(interval)) return billingPeriods.addPlanDuration(plan, now);

    const fallbackDays = interval === 'trial' ? 1 : 30;
    const rawDays = Number(plan.duration_days || plan.durationDays || fallbackDays);
    const days = Math.max(1, Math.min(Number.isFinite(rawDays) ? rawDays : fallbackDays, MAX_DURATION_DAYS));
    return new Date(new Date(now).getTime() + days * 86400000);
}

function visibleExpiry(plan, value) {
    return isFreeTier(plan) ? null : value || null;
}

module.exports = { FREE_TIER_END_ISO, isFreeTier, freeTierEnd, endForPlan, visibleExpiry };
