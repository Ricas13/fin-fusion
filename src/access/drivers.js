'use strict';

const DRIVERS = Object.freeze({
  concurrent_streams: Object.freeze({
    id: 'concurrent_streams',
    label: 'Concurrent streams',
    modules: ['jellyfin']
  }),
  household_network: Object.freeze({
    id: 'household_network',
    label: 'Household network',
    modules: ['jellyfin', 'stremio']
  }),
  managed_users: Object.freeze({
    id: 'managed_users',
    label: 'Managed users',
    modules: ['reseller'],
    future: true
  })
});

const DEFAULT_HOUSEHOLD_NETWORK_LIMIT = 1;
const DEFAULT_HOUSEHOLD_LEASE_MINUTES = 240;

function normalizeDriver(value, fallback = 'concurrent_streams') {
  const key = String(value || '').trim().toLowerCase();
  return DRIVERS[key] ? key : fallback;
}

function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function householdConfig(source = {}) {
  return {
    networkLimit: boundedInt(source.household_network_limit, 1, 10, DEFAULT_HOUSEHOLD_NETWORK_LIMIT),
    leaseMinutes: boundedInt(source.household_lease_minutes, 15, 1440, DEFAULT_HOUSEHOLD_LEASE_MINUTES)
  };
}

function concurrentStreamConfig(source = {}) {
  const streams = Number(source.streams);
  return { streamLimit: Number.isInteger(streams) && streams >= 1 ? Math.min(50, streams) : 1 };
}

module.exports = {
  DRIVERS,
  DEFAULT_HOUSEHOLD_NETWORK_LIMIT,
  DEFAULT_HOUSEHOLD_LEASE_MINUTES,
  normalizeDriver,
  boundedInt,
  householdConfig,
  concurrentStreamConfig
};
