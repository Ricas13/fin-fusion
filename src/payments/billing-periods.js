'use strict';

function addCalendarMonths(from, months) {
    const start = new Date(from), result = new Date(start.getTime());
    if (!Number.isFinite(start.getTime())) return result;
    const originalDay = start.getUTCDate();
    const absoluteMonth = start.getUTCMonth() + Number(months);
    const targetYear = start.getUTCFullYear() + Math.floor(absoluteMonth / 12);
    const targetMonth = ((absoluteMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    result.setUTCFullYear(targetYear, targetMonth, Math.min(originalDay, lastDay));
    return result;
}

function addPlanDuration(plan, from = new Date()) {
    const interval = String(plan?.billing_interval || plan?.billingInterval || '').toLowerCase();
    if (interval === 'month') return addCalendarMonths(from, 1);
    if (interval === '6_months') return addCalendarMonths(from, 6);
    if (interval === 'year') return addCalendarMonths(from, 12);
    const days = Number(plan?.duration_days || plan?.durationDays || 30);
    return new Date(new Date(from).getTime() + days * 86400000);
}

module.exports = { addCalendarMonths, addPlanDuration };
