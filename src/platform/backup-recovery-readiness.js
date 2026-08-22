'use strict';

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageHours(value, now = new Date()) {
  const date = asDate(value);
  const current = asDate(now) || new Date();
  if (!date) return null;
  return Math.max(0, (current.getTime() - date.getTime()) / 3600000);
}

function statusRank(kind) {
  return kind === 'bad' ? 2 : kind === 'warn' ? 1 : 0;
}

function newest(rows, predicate) {
  return (Array.isArray(rows) ? rows : []).find(predicate) || null;
}

function deriveRecoveryReadiness({ policy = {}, worker = null, runs = [], verificationRequests = [], now = new Date() } = {}) {
  const intervalHours = Math.max(1, Number(policy.intervalHours) || 24);
  const scheduleEnabled = policy.enabled !== false;
  const workerAgeSeconds = worker?.heartbeat_age_seconds == null ? null : Number(worker.heartbeat_age_seconds);
  const workerFresh = Boolean(worker) && Number.isFinite(workerAgeSeconds) && workerAgeSeconds >= 0 && workerAgeSeconds < 180;
  const successfulRuns = (Array.isArray(runs) ? runs : []).filter(run => run?.status === 'succeeded');
  const latestSuccessful = successfulRuns[0] || null;
  const latestVerified = newest(successfulRuns, run => Boolean(run?.verified_at));
  const latestAgeHours = ageHours(latestSuccessful?.completed_at || latestSuccessful?.started_at, now);
  const freshnessLimitHours = Math.max(intervalHours * 2 + 1, intervalHours + 6);
  const latestFresh = latestAgeHours != null && latestAgeHours <= freshnessLimitHours;
  const latestVerifiedCurrent = Boolean(latestSuccessful?.verified_at);
  const latestRequest = latestSuccessful
    ? newest(verificationRequests, request => String(request?.backup_run_id || '') === String(latestSuccessful.id || ''))
    : null;
  const verificationInFlight = ['queued', 'running'].includes(String(latestRequest?.status || ''));

  let protection;
  if (!scheduleEnabled) {
    protection = {
      kind: 'warn',
      state: 'off',
      label: 'Scheduled backups off',
      detail: latestSuccessful
        ? 'Existing recovery points remain available, but CAPTAiNFiN is not creating new scheduled backups.'
        : 'No scheduled protection is active.'
    };
  } else if (!worker) {
    protection = { kind: 'bad', state: 'missing_worker', label: 'Backup worker missing', detail: 'The scheduled backup worker has not registered.' };
  } else if (!workerFresh) {
    protection = { kind: 'bad', state: 'stale_worker', label: 'Backup worker stale', detail: 'The backup worker heartbeat is older than three minutes.' };
  } else if (worker.last_error) {
    protection = { kind: 'bad', state: 'worker_error', label: 'Backup failure needs attention', detail: String(worker.last_error).slice(0, 300) };
  } else if (!latestSuccessful) {
    protection = { kind: 'warn', state: 'no_backup', label: 'Waiting for first backup', detail: 'The worker is healthy, but no successful recovery point exists yet.' };
  } else if (!latestFresh) {
    protection = { kind: 'warn', state: 'stale_backup', label: 'Latest backup is old', detail: `No successful backup has completed within the last ${Math.round(freshnessLimitHours)} hours.` };
  } else {
    protection = { kind: 'good', state: 'healthy', label: 'Scheduled protection healthy', detail: 'The worker is healthy and the latest backup is within the expected schedule window.' };
  }

  let recovery;
  if (!latestSuccessful) {
    recovery = { kind: 'bad', state: 'no_recovery_point', label: 'No recovery point', detail: 'Create a backup before relying on recovery.' };
  } else if (latestVerifiedCurrent) {
    recovery = { kind: 'good', state: 'verified', label: 'Latest backup verified', detail: 'The latest encrypted backup completed a full temporary-database restore verification.' };
  } else if (verificationInFlight) {
    recovery = {
      kind: 'warn',
      state: latestRequest.status,
      label: latestRequest.status === 'running' ? 'Verification running' : 'Verification queued',
      detail: 'The latest backup has not yet completed its full restore drill.'
    };
  } else if (latestRequest?.status === 'failed') {
    recovery = { kind: 'bad', state: 'verification_failed', label: 'Latest verification failed', detail: String(latestRequest.error || latestSuccessful.verification_note || 'The latest backup did not pass restore verification.').slice(0, 300) };
  } else {
    recovery = {
      kind: 'warn',
      state: 'unverified',
      label: 'Latest backup needs verification',
      detail: latestVerified
        ? 'An older recovery point was verified, but the newest backup has not yet passed a full restore drill.'
        : 'No successful backup has completed a full restore drill yet.'
    };
  }

  const overallKind = statusRank(protection.kind) >= statusRank(recovery.kind) ? protection.kind : recovery.kind;
  const overall = overallKind === 'good'
    ? { kind: 'good', label: 'Recovery ready', detail: 'Scheduled protection is healthy and the latest recovery point has been proven by a full temporary restore.' }
    : overallKind === 'bad'
      ? { kind: 'bad', label: 'Recovery needs attention', detail: 'At least one backup or recovery check is failing.' }
      : { kind: 'warn', label: 'Recovery not fully proven', detail: 'Backups exist, but one or more protection or verification checks still need attention.' };

  return {
    intervalHours,
    freshnessLimitHours,
    scheduleEnabled,
    workerFresh,
    latestSuccessful,
    latestVerified,
    latestAgeHours,
    latestFresh,
    latestRequest,
    verificationInFlight,
    protection,
    recovery,
    overall
  };
}

module.exports = { asDate, ageHours, deriveRecoveryReadiness };
