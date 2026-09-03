'use strict';

const { query, getPool } = require('../db');
const reconciliationLock = require('../jellyfin/reconciliation-lock');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function poolSnapshot() {
  try {
    const pool = getPool();
    return {
      total: number(pool.totalCount),
      idle: number(pool.idleCount),
      waiting: number(pool.waitingCount),
      max: number(pool.options?.max)
    };
  } catch (error) {
    console.warn('Operational DB pool diagnostics unavailable.', { error: String(error?.message || error).slice(0, 300) });
    return { total: 0, idle: 0, waiting: 0, max: 0, unavailable: true };
  }
}

async function backlogSnapshot() {
  try {
    const result = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM payment_events WHERE processed_at IS NULL AND processing_error IS NOT NULL) AS payment_event_retries,
        (SELECT COUNT(*)::int FROM provider_operations
          WHERE state IN ('planned','provider_applied','local_applied','failed')
            AND manual_review_required=FALSE
            AND COALESCE(failure_kind,'') NOT IN ('terminal','superseded')) AS provider_recovery,
        (SELECT COUNT(*)::int FROM provider_operations WHERE manual_review_required=TRUE) AS provider_manual_review,
        (SELECT COUNT(*)::int FROM automatic_free_downgrade_retries) AS free_downgrade_retries,
        (SELECT COUNT(*)::int FROM automatic_free_downgrade_retries WHERE next_attempt_at<=NOW()) AS free_downgrade_due,
        (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status IN ('blocked','failed')) AS provisioning_problems,
        (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status='running') AS provisioning_running
    `);
    const row = result.rows[0] || {};
    return {
      paymentEventRetries: number(row.payment_event_retries),
      providerRecovery: number(row.provider_recovery),
      providerManualReview: number(row.provider_manual_review),
      freeDowngradeRetries: number(row.free_downgrade_retries),
      freeDowngradeDue: number(row.free_downgrade_due),
      provisioningProblems: number(row.provisioning_problems),
      provisioningRunning: number(row.provisioning_running),
      available: true
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    console.warn('Operational backlog diagnostics unavailable.', { error: message });
    return {
      paymentEventRetries: 0,
      providerRecovery: 0,
      providerManualReview: 0,
      freeDowngradeRetries: 0,
      freeDowngradeDue: 0,
      provisioningProblems: 0,
      provisioningRunning: 0,
      available: false,
      warning: 'Operational backlog metrics are temporarily unavailable.'
    };
  }
}

async function collect() {
  const backlog = await backlogSnapshot();
  let reconciliation;
  try {
    reconciliation = reconciliationLock.concurrencySnapshot();
  } catch (error) {
    console.warn('Reconciliation concurrency diagnostics unavailable.', { error: String(error?.message || error).slice(0, 300) });
    reconciliation = { active: 0, queued: 0, limit: 0, total: 0, succeeded: 0, failed: 0, lockTimeouts: 0, canceled: 0, unavailable: true };
  }
  return {
    databasePool: poolSnapshot(),
    reconciliation,
    backlog,
    generatedAt: new Date().toISOString()
  };
}

function supportSnapshot(metrics = {}) {
  const pool = metrics.databasePool || {};
  const reconciliation = metrics.reconciliation || {};
  const backlog = metrics.backlog || {};
  return {
    databasePool: {
      total: number(pool.total), idle: number(pool.idle), waiting: number(pool.waiting), max: number(pool.max), unavailable: pool.unavailable === true
    },
    reconciliation: {
      active: number(reconciliation.active), queued: number(reconciliation.queued), limit: number(reconciliation.limit),
      total: number(reconciliation.total), succeeded: number(reconciliation.succeeded), failed: number(reconciliation.failed),
      lockTimeouts: number(reconciliation.lockTimeouts), canceled: number(reconciliation.canceled),
      averageDurationMs: number(reconciliation.averageDurationMs), averageSlotWaitMs: number(reconciliation.averageSlotWaitMs),
      averageDbLockWaitMs: number(reconciliation.averageDbLockWaitMs), maxDurationMs: number(reconciliation.maxDurationMs),
      maxSlotWaitMs: number(reconciliation.maxSlotWaitMs), maxDbLockWaitMs: number(reconciliation.maxDbLockWaitMs),
      unavailable: reconciliation.unavailable === true
    },
    backlog: {
      paymentEventRetries: number(backlog.paymentEventRetries), providerRecovery: number(backlog.providerRecovery),
      providerManualReview: number(backlog.providerManualReview), freeDowngradeRetries: number(backlog.freeDowngradeRetries),
      freeDowngradeDue: number(backlog.freeDowngradeDue), provisioningProblems: number(backlog.provisioningProblems),
      provisioningRunning: number(backlog.provisioningRunning), available: backlog.available !== false
    }
  };
}

module.exports = { collect, backlogSnapshot, poolSnapshot, supportSnapshot, number };
