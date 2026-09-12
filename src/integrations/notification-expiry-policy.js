'use strict';

const SUPPORTED_MILESTONES = Object.freeze([3, 0]);
const DEFAULT_POLICY = Object.freeze({ milestones: SUPPORTED_MILESTONES });

function inputMilestones(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.milestones)) return value.milestones;
    if (value == null || value === '') return [];
    return [value];
}

function normalizeMilestones(value, { fallback = DEFAULT_POLICY.milestones } = {}) {
    const supported = new Set(SUPPORTED_MILESTONES);
    const normalized = [...new Set(inputMilestones(value)
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isInteger(item) && supported.has(item)))]
        .sort((a, b) => b - a);
    return normalized.length ? normalized : [...fallback];
}

function normalizePolicy(value, { fallback = DEFAULT_POLICY } = {}) {
    return { milestones: normalizeMilestones(value?.milestones ?? value, { fallback: fallback.milestones }) };
}

async function load() {
    return { milestones: [...SUPPORTED_MILESTONES] };
}

module.exports = {
    SUPPORTED_MILESTONES,
    DEFAULT_POLICY,
    normalizeMilestones,
    normalizePolicy,
    load
};
