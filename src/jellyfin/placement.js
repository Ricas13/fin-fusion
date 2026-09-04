'use strict';

const crypto = require('crypto');
const { query } = require('../db');

const STRATEGIES = new Set(['balanced', 'lowest_customers', 'lowest_streams', 'weighted', 'manual']);
const DEFAULT_STALE_MS = 5 * 60 * 1000;
let fleetSnapshot = new Map();
let snapshotLoadedAt = 0;
let refreshTimer = null;

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

function staleMs() {
    const seconds = Number(process.env.PLACEMENT_FLEET_METRICS_STALE_SECONDS || 300);
    if (!Number.isFinite(seconds)) return DEFAULT_STALE_MS;
    return Math.max(60, Math.min(1800, seconds)) * 1000;
}

function metricFor(server) {
    const metric = fleetSnapshot.get(String(server?.id || ''));
    if (!metric?.observedAt) return null;
    const observed = new Date(metric.observedAt).getTime();
    if (!Number.isFinite(observed) || Date.now() - observed > staleMs()) return null;
    return metric;
}

function fleetLoad(server) {
    const metric = metricFor(server);
    const managedUsers = number(server?.assigned_users, 0);
    const explicitUsers = Number(server?.capacity_users);
    const users = Number.isFinite(explicitUsers) && explicitUsers >= 0 ? explicitUsers : managedUsers;
    const managedStreams = number(server?.active_streams, 0);
    return {
        // Capacity is intentionally customer-user based. Jellyfin's raw total_users
        // can include administrators, service identities or unmanaged accounts and
        // must never open/close storefront or automatic placement capacity.
        users,
        streams: metric?.activeStreams == null ? managedStreams : number(metric.activeStreams, managedStreams),
        managedUsers,
        managedStreams,
        source: Number.isFinite(explicitUsers) && explicitUsers >= 0 ? 'capacity' : 'managed',
        observedAt: null
    };
}

function atCapacity(server) {
    const max = number(server?.max_users, 0);
    return max > 0 && fleetLoad(server).users >= max;
}

function loadRatio(server) {
    const max = number(server.max_users, 0);
    const users = fleetLoad(server).users;
    if (max > 0) return users / max;
    return users / 1000;
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
    const al = fleetLoad(a);
    const bl = fleetLoad(b);
    return baseHealthCompare(a, b)
        || loadRatio(a) - loadRatio(b)
        || al.streams - bl.streams
        || al.users - bl.users
        || tieBreak(a, b);
}

function customerCompare(a, b) {
    const al = fleetLoad(a);
    const bl = fleetLoad(b);
    return baseHealthCompare(a, b)
        || al.users - bl.users
        || al.streams - bl.streams
        || loadRatio(a) - loadRatio(b)
        || tieBreak(a, b);
}

function streamCompare(a, b) {
    const al = fleetLoad(a);
    const bl = fleetLoad(b);
    return baseHealthCompare(a, b)
        || al.streams - bl.streams
        || al.users - bl.users
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
    const raw = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!raw.length) return null;
    const strategy = normalizeStrategy(strategyValue);
    const candidatesList = raw.filter(server => !atCapacity(server));
    if (!candidatesList.length) return null;

    if (strategy === 'manual') {
        if (raw.length !== 1) {
            throw new Error('Manual server placement requires exactly one eligible Jellyfin server.');
        }
        return candidatesList[0] || null;
    }
    if (strategy === 'weighted') return weightedPick(candidatesList, randomInt);
    if (strategy === 'lowest_customers') return [...candidatesList].sort(customerCompare)[0];
    if (strategy === 'lowest_streams') return [...candidatesList].sort(streamCompare)[0];
    return [...candidatesList].sort(balancedCompare)[0];
}

async function refreshFleetSnapshot() {
    const result = await query(`
        SELECT server_id,active_streams,managed_streams,observed_at
        FROM jellyfin_server_metrics
        WHERE observed_at IS NOT NULL
    `);
    const next = new Map();
    for (const row of result.rows) {
        next.set(String(row.server_id), {
            activeStreams: row.active_streams == null ? null : Number(row.active_streams),
            managedStreams: row.managed_streams == null ? null : Number(row.managed_streams),
            observedAt: row.observed_at
        });
    }
    fleetSnapshot = next;
    snapshotLoadedAt = Date.now();
    return next.size;
}

function startFleetSnapshotRefresh() {
    if (refreshTimer || !process.env.DATABASE_URL) return;
    const run = () => refreshFleetSnapshot().catch(error => {
        console.warn('Placement fleet snapshot refresh failed:', error.message);
    });
    run();
    refreshTimer = setInterval(run, 30000);
    refreshTimer.unref?.();
}

function snapshotStatus() {
    return { serverCount: fleetSnapshot.size, loadedAt: snapshotLoadedAt || null, staleAfterMs: staleMs() };
}

function setFleetSnapshotForTests(entries) {
    fleetSnapshot = new Map((entries || []).map(entry => [String(entry.serverId), {
        activeStreams: entry.activeStreams,
        managedStreams: entry.managedStreams,
        observedAt: entry.observedAt || new Date()
    }]));
    snapshotLoadedAt = Date.now();
}

module.exports = {
    STRATEGIES,
    normalizeStrategy,
    healthRank,
    loadRatio,
    fleetLoad,
    atCapacity,
    selectServer,
    metricsStaleMs: staleMs,
    refreshFleetSnapshot,
    startFleetSnapshotRefresh,
    snapshotStatus,
    setFleetSnapshotForTests
};
