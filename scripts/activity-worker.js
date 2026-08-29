'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const pkg = require('../package.json');
if (!process.env.ACTIVITY_DATABASE_URL) throw new Error('ACTIVITY_DATABASE_URL is required');
if (!process.env.JELLYFIN_ENCRYPTION_KEY) throw new Error('JELLYFIN_ENCRYPTION_KEY is required');
if (!process.env.ACTIVITY_ENCRYPTION_KEY) throw new Error('ACTIVITY_ENCRYPTION_KEY is required');
process.env.DATABASE_URL = process.env.ACTIVITY_DATABASE_URL;
process.env.DATA_ENCRYPTION_KEY = process.env.ACTIVITY_ENCRYPTION_KEY;
process.env.ALLOW_LEGACY_DATA_KEY_FOR_JELLYFIN = 'false';

const { query, getPool } = require('../src/db');
const { withMaintenanceSharedLock } = require('../src/security/maintenance-lock');
const activity = require('../src/jellyfin/lane-stream-policy');
const activityTrust = require('../src/jellyfin/activity-trust');
const householdNetworkPolicy = require('../src/jellyfin/household-network-policy');
const fleetMetrics = require('../src/jellyfin/fleet-metrics');
const streamPolicy = require('../src/jellyfin/stream-policy-settings');

const intervalSeconds = Math.max(15, Math.min(300, Number(process.env.STREAM_POLICY_POLL_SECONDS || 20)));
const fleetIntervalSeconds = Math.max(30, Math.min(900, Number(process.env.FLEET_METRICS_POLL_SECONDS || 60)));
const HEARTBEAT_FILE = process.env.ACTIVITY_HEARTBEAT_FILE || '/tmp/activity-heartbeat';
const INSTANCE_ID = String(process.env.HOSTNAME || `activity-${crypto.randomUUID()}`).slice(0, 200);
const COMMIT_SHA = String(process.env.COMMIT_SHA || process.env.CAPTAINFIN_BUILD_SHA || process.env.GITHUB_SHA || '').slice(0, 80) || null;
let lastFleetRun = 0;
let shuttingDown = false;
let sleepTimer = null;
let sleepResolve = null;
let lastPolicyReload = 0;
let cycleState = {
  outcome: 'starting',
  completedAt: null,
  durationMs: null,
  observedStreams: 0,
  serverFailures: 0,
  policyMode: String(process.env.STREAM_POLICY_MODE || 'observe').slice(0, 40)
};

function heartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString(), { mode: 0o600 });
  } catch (error) {
    console.warn('Activity heartbeat write failed:', error.message);
  }
}

function operationalMetadata() {
  return {
    pollSeconds: intervalSeconds,
    fleetIntervalSeconds,
    lastCycleAt: cycleState.completedAt,
    lastCycleDurationMs: cycleState.durationMs,
    lastCycleOutcome: cycleState.outcome,
    observedStreams: Number(cycleState.observedStreams || 0),
    serverFailures: Number(cycleState.serverFailures || 0),
    policyMode: String(cycleState.policyMode || 'observe').slice(0, 40)
  };
}

async function operationalHeartbeat({ draining = false } = {}) {
  const guarded = await withMaintenanceSharedLock(async () => {
    await query(
      'SELECT public.record_activity_worker_heartbeat($1,$2,$3,$4,$5::jsonb)',
      [INSTANCE_ID, pkg.version || null, COMMIT_SHA, Boolean(draining), JSON.stringify(operationalMetadata())]
    );
    return { recorded: true };
  }, { skipIfBusy: true });
  return guarded?.skipped ? { recorded: false, reason: guarded.reason } : guarded;
}

async function refreshPolicyIfDue() {
  if (Date.now() - lastPolicyReload < 30000) return;
  lastPolicyReload = Date.now();
  try {
    const loaded = await streamPolicy.reloadIntoEnvironment();
    cycleState.policyMode = loaded.mode;
    console.log(`Stream policy mode=${loaded.mode} grace=${loaded.graceSeconds}s confirmations=${loaded.confirmationsRequired}`);
  } catch (error) {
    console.warn('Stream policy settings unavailable; keeping last safe configuration:', error.message);
  }
}

async function refreshFleetMetricsIfDue() {
  const now = Date.now();
  if (now - lastFleetRun < fleetIntervalSeconds * 1000) return null;
  lastFleetRun = now;
  const results = await fleetMetrics.refreshAll();
  const failures = results.filter(result => !result.ok);
  const streams = results.filter(result => result.ok).reduce((sum, result) => sum + Number(result.activeStreams || 0), 0);
  if (failures.length) console.warn(`Fleet metrics: ${failures.length}/${results.length} server(s) unavailable; observed streams=${streams}`);
  return { total: results.length, failures: failures.length, streams };
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

async function recordActivityPollTrust(result) {
  if (!result || result.skipped) return;
  const serverIds = await activityTrust.managedServerIds();
  await activityTrust.recordCycle(serverIds, result.serverFailures || [], new Date());
}

async function run() {
  heartbeat();
  await operationalHeartbeat().catch(error => console.warn('Activity operational heartbeat unavailable:', error.message));
  while (!shuttingDown) {
    const started = Date.now();
    const current = {
      outcome: 'healthy',
      observedStreams: 0,
      serverFailures: 0,
      policyMode: cycleState.policyMode
    };
    try {
      const guarded = await withMaintenanceSharedLock(async () => {
        await refreshPolicyIfDue();
        current.policyMode = cycleState.policyMode;
        try {
          const result = await activity.runActivityPolicyCycle();
          current.observedStreams = Number(result?.observedStreams || 0);
          current.serverFailures = Array.isArray(result?.serverFailures) ? result.serverFailures.length : 0;
          if (current.serverFailures) current.outcome = 'degraded';
          try {
            await recordActivityPollTrust(result);
          } catch (error) {
            current.outcome = 'degraded';
            console.error('Activity poll trust ledger update failed:', error.message);
          }
          if (!result.skipped) {
            console.log(`Activity cycle mode=${result.mode} streams=${result.observedStreams} violations=${result.violations} durationMs=${Date.now() - started}`);
            const household = await householdNetworkPolicy.runHouseholdNetworkCycle({ pollsReliable: !result.serverFailures?.length });
            if (!household.skipped && household.customers) {
              console.log(`Household network cycle customers=${household.customers} sessions=${household.observedSessions} denied=${household.denied} stopped=${household.stopped} safetySkipped=${household.safetySkipped}`);
            }
          }
        } catch (error) {
          current.outcome = 'failed';
          console.error('Activity cycle failed:', error.message);
        }
        try {
          const fleet = await refreshFleetMetricsIfDue();
          if (fleet) {
            current.observedStreams = Math.max(current.observedStreams, Number(fleet.streams || 0));
            current.serverFailures = Math.max(current.serverFailures, Number(fleet.failures || 0));
            if (fleet.failures && current.outcome === 'healthy') current.outcome = 'degraded';
          }
        } catch (error) {
          if (current.outcome === 'healthy') current.outcome = 'degraded';
          console.error('Fleet metrics refresh failed:', error.message);
        }
        return { processed: true };
      }, { skipIfBusy: true });
      if (guarded?.skipped && guarded?.reason === 'database_maintenance') {
        current.outcome = 'maintenance';
        console.log('Activity cycle skipped during database maintenance.');
      }
    } catch (error) {
      current.outcome = 'failed';
      console.error('Activity maintenance guard failed:', error.message);
    }
    cycleState = {
      ...current,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started
    };
    heartbeat();
    await operationalHeartbeat().catch(error => console.warn('Activity operational heartbeat unavailable:', error.message));
    if (!shuttingDown) await sleep(intervalSeconds * 1000);
  }
  heartbeat();
  await operationalHeartbeat({ draining: true }).catch(() => {});
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
  cycleState = { ...cycleState, outcome: 'failed', completedAt: new Date().toISOString() };
  await operationalHeartbeat({ draining: true }).catch(() => {});
  process.exitCode = 1;
  try { await getPool().end(); } catch (_) {}
});