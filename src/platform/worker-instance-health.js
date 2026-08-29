'use strict';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function freshnessSeconds(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const key = String(row?.worker_key || '');
  if (key === 'activity') return Math.max(120, Math.min(1800, number(metadata.pollSeconds || 30) * 4));
  if (key === 'automation') {
    const pollSeconds = Math.ceil(number(metadata.pollMs || 15000) / 1000);
    return Math.max(90, Math.min(900, pollSeconds * 4));
  }
  return 90;
}

function instanceState(row) {
  if (!row) return 'missing';
  if (row.draining_at) return 'draining';
  if (number(row.heartbeat_age_seconds) > freshnessSeconds(row)) return 'stale';
  const outcome = String(row.metadata?.lastCycleOutcome || '').toLowerCase();
  if (outcome === 'failed') return 'failed';
  if (outcome === 'degraded') return 'degraded';
  if (outcome === 'maintenance') return 'maintenance';
  return 'healthy';
}

function clean(value, max = 200) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function instanceView(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const instanceId = clean(row?.instance_id, 200) || 'unknown';
  return {
    key: clean(row?.worker_key, 80) || 'unknown',
    instanceId,
    version: clean(row?.version, 80),
    commitSha: clean(row?.commit_sha, 80),
    startedAt: row?.started_at || null,
    lastHeartbeatAt: row?.last_heartbeat_at || null,
    heartbeatAgeSeconds: number(row?.heartbeat_age_seconds),
    freshnessSeconds: freshnessSeconds(row),
    state: instanceState(row),
    draining: Boolean(row?.draining_at),
    hostname: clean(metadata.hostname, 200) || instanceId,
    containerId: clean(metadata.containerId, 200),
    containerName: clean(metadata.containerName, 200),
    lastCycleOutcome: clean(metadata.lastCycleOutcome, 24),
    serverFailures: number(metadata.serverFailures)
  };
}

function summarize(rows = []) {
  const instances = rows.map(instanceView);
  const byRole = new Map();
  for (const instance of instances) {
    if (!byRole.has(instance.key)) byRole.set(instance.key, []);
    byRole.get(instance.key).push(instance);
  }

  const warnings = [];
  const workers = [];
  for (const [key, roleInstances] of byRole) {
    const live = roleInstances.filter(instance => instance.state !== 'stale');
    const active = live.filter(instance => !instance.draining);
    const latest = [...roleInstances].sort((a, b) => a.heartbeatAgeSeconds - b.heartbeatAgeSeconds)[0];
    const commits = [...new Set(active.map(instance => instance.commitSha).filter(Boolean))];
    const versions = [...new Set(active.map(instance => instance.version).filter(Boolean))];
    if (active.length > 1) warnings.push({ type: 'duplicate_instances', workerKey: key, instanceCount: active.length, instanceIds: active.map(instance => instance.instanceId) });
    if (commits.length > 1 || (!commits.length && versions.length > 1)) warnings.push({ type: 'version_skew', workerKey: key, commitShas: commits, versions, instanceIds: active.map(instance => instance.instanceId) });
    for (const instance of roleInstances.filter(item => item.state === 'stale')) warnings.push({ type: 'stale_instance', workerKey: key, instanceId: instance.instanceId, heartbeatAgeSeconds: instance.heartbeatAgeSeconds });
    workers.push({
      key,
      heartbeatAgeSeconds: latest.heartbeatAgeSeconds,
      freshnessSeconds: latest.freshnessSeconds,
      state: live.length ? latest.state : 'stale',
      lastCycleOutcome: latest.lastCycleOutcome,
      serverFailures: latest.serverFailures,
      instanceCount: roleInstances.length,
      liveInstances: active.length
    });
  }

  const activeInstances = instances.filter(instance => instance.state !== 'stale' && !instance.draining);
  const liveCommits = [...new Set(activeInstances.map(instance => instance.commitSha).filter(Boolean))];
  if (liveCommits.length > 1 && !warnings.some(warning => warning.type === 'version_skew')) warnings.push({ type: 'version_skew', workerKey: null, commitShas: liveCommits, versions: [], instanceIds: activeInstances.map(instance => instance.instanceId) });

  return { workers, instances, warnings };
}

module.exports = { freshnessSeconds, instanceState, instanceView, summarize };
