'use strict';

require('dotenv').config();
const fs = require('fs');
if (!process.env.ACTIVITY_DATABASE_URL) throw new Error('ACTIVITY_DATABASE_URL is required');
if (!process.env.JELLYFIN_ENCRYPTION_KEY) throw new Error('JELLYFIN_ENCRYPTION_KEY is required');
if (!process.env.ACTIVITY_ENCRYPTION_KEY) throw new Error('ACTIVITY_ENCRYPTION_KEY is required');
process.env.DATABASE_URL = process.env.ACTIVITY_DATABASE_URL;
process.env.DATA_ENCRYPTION_KEY = process.env.ACTIVITY_ENCRYPTION_KEY;
process.env.ALLOW_LEGACY_DATA_KEY_FOR_JELLYFIN = 'false';

const { getPool } = require('../src/db');
const { withMaintenanceSharedLock } = require('../src/security/maintenance-lock');
const activity = require('../src/jellyfin/activity');
const householdNetworkPolicy = require('../src/jellyfin/household-network-policy');
const fleetMetrics = require('../src/jellyfin/fleet-metrics');
const streamPolicy = require('../src/jellyfin/stream-policy-settings');

const intervalSeconds = Math.max(10, Math.min(300, Number(process.env.STREAM_POLICY_POLL_SECONDS || 30)));
const fleetIntervalSeconds = Math.max(30, Math.min(900, Number(process.env.FLEET_METRICS_POLL_SECONDS || 60)));
const HEARTBEAT_FILE = process.env.ACTIVITY_HEARTBEAT_FILE || '/tmp/activity-heartbeat';
let lastFleetRun = 0;
let shuttingDown = false;
let sleepTimer = null;
let sleepResolve = null;
let lastPolicyReload = 0;

function heartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), { mode: 0o600 });
  } catch (error) {
    console.warn('Activity heartbeat write failed:', error.message);
  }
}

async function refreshPolicyIfDue() {
  if (Date.now() - lastPolicyReload < 30000) return;
  lastPolicyReload = Date.now();
  try {
    const loaded = await streamPolicy.reloadIntoEnvironment();
    console.log(`Stream policy mode=${loaded.mode} grace=${loaded.graceSeconds}s confirmations=${loaded.confirmationsRequired}`);
  } catch (error) {
    console.warn('Stream policy settings unavailable; keeping last safe configuration:', error.message);
  }
}

async function refreshFleetMetricsIfDue() {
  const now = Date.now();
  if (now - lastFleetRun < fleetIntervalSeconds * 1000) return;
  lastFleetRun = now;
  const results = await fleetMetrics.refreshAll();
  const failures = results.filter(result => !result.ok);
  const streams = results.filter(result => result.ok).reduce((sum, result) => sum + Number(result.activeStreams || 0), 0);
  if (failures.length) console.warn(`Fleet metrics: ${failures.length}/${results.length} server(s) unavailable; observed streams=${streams}`);
}

function sleep(ms) {
  return new Promise(resolve => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

async function run() {
  heartbeat();
  while (!shuttingDown) {
    const started = Date.now();
    try {
      const guarded = await withMaintenanceSharedLock(async () => {
        await refreshPolicyIfDue();
        try {
          const result = await activity.runActivityPolicyCycle();
          if (!result.skipped) {
            console.log(`Activity cycle mode=${result.mode} streams=${result.observedStreams} violations=${result.violations} durationMs=${Date.now() - started}`);
            const household = await householdNetworkPolicy.runHouseholdNetworkCycle({ pollsReliable: !result.serverFailures?.length });
            if (!household.skipped && household.customers) {
              console.log(`Household network cycle customers=${household.customers} sessions=${household.observedSessions} denied=${household.denied} stopped=${household.stopped} safetySkipped=${household.safetySkipped}`);
            }
          }
        } catch (error) {
          console.error('Activity cycle failed:', error.message);
        }
        try {
          await refreshFleetMetricsIfDue();
        } catch (error) {
          console.error('Fleet metrics refresh failed:', error.message);
        }
        return { processed: true };
      }, { skipIfBusy: true });
      if (guarded?.skipped && guarded?.reason === 'database_maintenance') console.log('Activity cycle skipped during database maintenance.');
    } catch (error) {
      console.error('Activity maintenance guard failed:', error.message);
    }
    heartbeat();
    if (!shuttingDown) await sleep(intervalSeconds * 1000);
  }
  heartbeat();
  try { await getPool().end(); } catch (_) {}
}

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Activity worker draining (${signal})`);
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    const resolve = sleepResolve;
    sleepResolve = null;
    resolve?.();
  }
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));
run().catch(async error => {
  console.error('Activity worker fatal error:', error.message);
  process.exitCode = 1;
  try { await getPool().end(); } catch (_) {}
});
