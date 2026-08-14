'use strict';

const crypto = require('crypto');

const STRATEGIES = new Set(['balanced', 'lowest_customers', 'lowest_streams', 'weighted', 'manual']);

function normalizeStrategy(value) {
    const strategy = String(value || 'balanced').trim().toLowerCase();
    return STRATEGIES.has(strategy) ? strategy : 'balanced';
}

function healthRank(status) {
    if (status === 'healthy') return 0;
    if (status === 'unknown') return 1;
    if (status === 'degraded') return 2;
    return 3;
}

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function loadRatio(server) {
    const max = number(server.max_users, 0);
    const assigned = number(server.assigned_users, 0);
    if (max > 0) return assigned / max;
    // Unlimited servers have no hard capacity ceiling. Keep them competitive,
    // but do not make every unlimited server permanently beat a lightly loaded
    // capped server solely because its denominator is missing.
    return assigned / 1000;
}

function tieBreak(a, b) {
    const priority = number(a.priority, 100) - number(b.priority, 100);
    if (priority) return priority;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
}

function baseHealthCompare(a, b) {
    return healthRank(a.health_status) - healthRank(b.health_status);
}

function balancedCompare(a, b) {
    return baseHealthCompare(a, b)
        || loadRatio(a) - loadRatio(b)
        || number(a.active_streams) - number(b.active_streams)
        || number(a.assigned_users) - number(b.assigned_users)
        || tieBreak(a, b);
}

function customerCompare(a, b) {
    return baseHealthCompare(a, b)
        || number(a.assigned_users) - number(b.assigned_users)
        || number(a.active_streams) - number(b.active_streams)
        || loadRatio(a) - loadRatio(b)
        || tieBreak(a, b);
}

function streamCompare(a, b) {
    return baseHealthCompare(a, b)
        || number(a.active_streams) - number(b.active_streams)
        || number(a.assigned_users) - number(b.assigned_users)
        || loadRatio(a) - loadRatio(b)
        || tieBreak(a, b);
}

function weightedPick(candidates, randomInt = crypto.randomInt) {
    const bestHealth = Math.min(...candidates.map(server => healthRank(server.health_status)));
    const pool = candidates.filter(server => healthRank(server.health_status) === bestHealth);
    const ordered = [...pool].sort(tieBreak);
    const weights = ordered.map(server => Math.max(1, Math.min(10000, Math.trunc(number(server.placement_weight, 100)))));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let draw = randomInt(total);
    for (let index = 0; index < ordered.length; index += 1) {
        draw -= weights[index];
        if (draw < 0) return ordered[index];
    }
    return ordered[ordered.length - 1] || null;
}

function selectServer(candidates, strategyValue, { randomInt = crypto.randomInt } = {}) {
    const candidatesList = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!candidatesList.length) return null;
    const strategy = normalizeStrategy(strategyValue);

    if (strategy === 'manual') {
        if (candidatesList.length !== 1) {
            throw new Error('Manual server placement requires exactly one eligible Jellyfin server.');
        }
        return candidatesList[0];
    }
    if (strategy === 'weighted') return weightedPick(candidatesList, randomInt);
    if (strategy === 'lowest_customers') return [...candidatesList].sort(customerCompare)[0];
    if (strategy === 'lowest_streams') return [...candidatesList].sort(streamCompare)[0];
    return [...candidatesList].sort(balancedCompare)[0];
}

module.exports = {
    STRATEGIES,
    normalizeStrategy,
    healthRank,
    loadRatio,
    selectServer
};
