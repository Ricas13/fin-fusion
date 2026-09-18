'use strict';

const { query } = require('../db');
const jobHealth = require('../automation/job-health');
const criticalJobs = require('../automation/critical-jobs');
const freeBackfill = require('../automation/free-capacity-backfill');
const freeDigest = require('../automation/free-places-digest');
const planCapacity = require('../entitlements/plan-capacity');
const inactivityPolicy = require('../entitlements/jellyfin-lifecycle-policy');
const notificationSettings = require('../integrations/notification-settings');
const operationsSettings = require('./operations-settings');
const discovery = require('../payments/subscription-discovery');
const { esc } = require('./admin-html');

const JOB_LABELS = Object.freeze({
  health: 'Jellyfin health',
  entitlements: 'Entitlements',
  free_capacity_backfill: 'Free capacity backfill',
  customer_inactivity: 'Free inactivity',
  customer_deletions: 'Customer deletions',
  creation_intent_recovery: 'Jellyfin creation recovery',
  customer_service_recovery: 'Access recovery',
  revenue_integrity: 'Revenue integrity',
  billing: 'Billing reconciliation',
  subscription_discovery: 'Subscription discovery',
  provider_checkout_recovery: 'Checkout recovery',
  provider_operation_recovery: 'Provider operation recovery',
  payment_events: 'Payment events',
  plan_changes: 'Plan changes',
  email_outbox: 'Transactional email',
  notification_outbox: 'Notifications',
  notification_lifecycle: 'Notification lifecycle',
  discord_roles: 'Discord roles',
  activation_cleanup: 'Activation cleanup',
  stremio_managed_accounts: 'Stremio access',
  stremio_external_tokens: 'Stremio tokens'
});
const RECENT_JOB_KEYS = new Set([
  'free_capacity_backfill',
  'customer_deletions',
  'creation_intent_recovery',
  'customer_service_recovery',
  'billing',
  'subscription_discovery',
  'provider_checkout_recovery',
  'provider_operation_recovery',
  'payment_events',
  'plan_changes',
  'discord_roles',
  'activation_cleanup',
  'stremio_managed_accounts',
  'stremio_external_tokens'
]);

function cleanError(error) {
  return String(error?.message || error || 'Unavailable').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function dateMs(value) {
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function ageLabel(value, now = Date.now()) {
  const ms = dateMs(value);
  if (!ms) return 'Never';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function jobLabel(key) {
  return JOB_LABELS[key] || String(key || 'Automation').replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function automationSnapshot(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map(list.map(row => [String(row.job_key), row]));
  const critical = criticalJobs.names().map(key => {
    const row = byKey.get(key) || { job_key: key };
    const state = row.job_key && byKey.has(key) ? jobHealth.healthState(row) : 'missing';
    const intentionallyDisabled = state === 'disabled' && criticalJobs.mayBeDisabled(key);
    return { ...row, job_key: key, state, intentionallyDisabled };
  });

  const warningStates = new Set(['failed', 'degraded', 'stale', 'missing', 'never_run']);
  const warnings = critical.filter(row => warningStates.has(row.state) || (row.state === 'disabled' && !row.intentionallyDisabled));
  const healthy = critical.filter(row => row.state === 'healthy').length;
  const running = critical.filter(row => row.state === 'running').length;
  const disabled = critical.filter(row => row.intentionallyDisabled).length;
  const latest = critical.reduce((value, row) => {
    const candidate = row.last_completed_at || row.last_success_at || null;
    return dateMs(candidate) > dateMs(value) ? candidate : value;
  }, null);

  return {
    total: critical.length,
    healthy,
    running,
    disabled,
    warningCount: warnings.length,
    latestCriticalCompletedAt: latest,
    warnings: warnings.slice(0, 5).map(row => ({
      key: row.job_key,
      label: jobLabel(row.job_key),
      state: row.state,
      error: row.last_error || row.last_warning || null
    }))
  };
}

function nextAdvertLabel(cfg, state, now = new Date(), { pending = false, publicBaseUrlConfigured = true } = {}) {
  if (!cfg?.discordFreePlacesDigestEnabled) return 'Advertising disabled';
  if (!cfg.discordConfigured) return 'Discord not configured';
  if (!cfg.discordFreePlacesChannelId) return 'Channel not configured';
  if (!publicBaseUrlConfigured) return 'Public URL not configured';
  const zone = cfg.discordFreePlacesTimezone || 'Europe/London';
  const times = [cfg.discordFreePlacesTime1, cfg.discordFreePlacesTime2]
    .filter(value => /^\d{2}:\d{2}$/.test(String(value || '')))
    .map(String)
    .sort();
  if (!times.length) return 'No advert times configured';

  const stamp = freeDigest.localStamp(now, zone);
  const currentDueKey = freeDigest.advertSlotKey(cfg, now);
  const currentChannel = String(cfg.discordFreePlacesChannelId || '');
  const stateChannel = String(state?.channelId || '');
  const hasCurrentBaseline = Boolean(
    state?.messageId &&
    state?.lastAdvertSlot &&
    stateChannel === currentChannel
  );
  if (pending && hasCurrentBaseline && currentDueKey && state.lastAdvertSlot !== currentDueKey) return `Due now · ${zone}`;

  const today = times.find(value => value > stamp.time);
  if (today) return `${today} today · ${zone}`;
  return `${times[0]} tomorrow · ${zone}`;
}

async function freeSnapshot(jobRows) {
  const [plan, policy, cfg, digestState, operations] = await Promise.all([
    freeDigest.freePlan(),
    inactivityPolicy.get(),
    notificationSettings.status(),
    freeDigest.loadState(),
    operationsSettings.get()
  ]);
  const publicBaseUrlConfigured = Boolean(String(operations.publicBaseUrl || '').trim());

  if (!plan) {
    return {
      configured: false,
      available: null,
      used: null,
      limit: null,
      waiting: 0,
      bufferedPlaces: 0,
      inactivityEnabled: Boolean(policy.enabled),
      inactivityState: 'missing',
      nextAdvert: nextAdvertLabel(cfg, digestState, new Date(), { publicBaseUrlConfigured })
    };
  }

  const [capacity, waitingRows, pendingClaims] = await Promise.all([
    planCapacity.usage(plan.id),
    freeBackfill.waitingCandidates(500, { planId: plan.id }),
    freeBackfill.pendingClaimCandidates(500, { planId: plan.id })
  ]);
  const inactivityJob = (jobRows || []).find(row => row.job_key === 'customer_inactivity') || null;
  const actualRemaining = capacity.remaining == null ? null : Math.max(0, Number(capacity.remaining) || 0);
  const configuredChannel = String(cfg.discordFreePlacesChannelId || '');
  const digestChannel = String(digestState.channelId || '');
  const digestCurrent = Boolean(
    cfg.discordFreePlacesDigestEnabled &&
    cfg.discordConfigured &&
    publicBaseUrlConfigured &&
    configuredChannel &&
    digestState.messageId &&
    digestChannel === configuredChannel
  );
  const advertisedRemaining = digestCurrent && digestState.remaining != null
    ? Math.max(0, Number(digestState.remaining) || 0)
    : null;
  const minimumAdvertRemaining = Math.max(1, Number(cfg.discordFreePlacesMinRemaining) || 1);
  const bufferedPlaces = actualRemaining == null || advertisedRemaining == null
    ? 0
    : Math.max(0, actualRemaining - advertisedRemaining);
  const advertPending = bufferedPlaces > 0 && actualRemaining >= minimumAdvertRemaining;

  return {
    configured: true,
    available: actualRemaining,
    used: capacity.used == null ? null : Number(capacity.used),
    reserved: capacity.reserved == null ? null : Number(capacity.reserved),
    limit: capacity.limit == null ? null : Number(capacity.limit),
    waiting: waitingRows.length + pendingClaims.length,
    waitingCapped: waitingRows.length >= 500 || pendingClaims.length >= 500,
    bufferedPlaces,
    inactivityEnabled: Boolean(policy.enabled),
    inactivityDryRun: Boolean(policy.dryRun),
    inactivityState: jobRows == null ? 'unavailable' : (inactivityJob ? jobHealth.healthState(inactivityJob) : 'missing'),
    inactivityLastCompletedAt: inactivityJob?.last_completed_at || inactivityJob?.last_success_at || null,
    nextAdvert: nextAdvertLabel(cfg, digestState, new Date(), { pending: advertPending, publicBaseUrlConfigured })
  };
}

async function billingSnapshot() {
  const [coverage, integrity] = await Promise.all([
    discovery.coverageStats(),
    query(`
      WITH recurring AS (
        SELECT s.id,s.status,s.cancel_at_period_end,ps.last_error
          FROM subscriptions s
          LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id
         WHERE s.billing_mode='subscription'
           AND s.source IN('stripe','paypal')
           AND s.status IN('active','trialing','past_due','paused')
      )
      SELECT
        (SELECT COUNT(*)::int FROM recurring WHERE NULLIF(BTRIM(last_error),'') IS NOT NULL) AS sync_problems,
        (SELECT COUNT(*)::int FROM recurring WHERE status='past_due' AND COALESCE(cancel_at_period_end,FALSE)=FALSE) AS past_due,
        (SELECT COUNT(*)::int
           FROM payment_events
          WHERE provider IN('stripe','paypal')
            AND NULLIF(BTRIM(processing_error),'') IS NOT NULL
            AND processed_at IS NULL) AS provider_event_errors
    `)
  ]);
  const row = integrity.rows[0] || {};
  const missing = Number(coverage.missing || 0);
  const syncProblems = Number(row.sync_problems || 0);
  const pastDue = Number(row.past_due || 0);
  const providerEventErrors = Number(row.provider_event_errors || 0);
  return {
    missing,
    syncProblems,
    pastDue,
    providerEventErrors,
    needsReview: missing > 0 || syncProblems > 0 || pastDue > 0 || providerEventErrors > 0
  };
}

async function inactivityAuditActions(limit = 5) {
  const bounded = Math.max(1, Math.min(10, Number(limit) || 5));
  const result = await query(`
    SELECT created_at,action,entity_id,metadata
      FROM audit_log
     WHERE actor_user_id IS NULL
       AND created_at>=NOW()-INTERVAL '7 days'
       AND action IN(
         'customer.inactivity.remove_jellyfin',
         'customer.inactivity.remove_failed',
         'customer.inactivity.would_remove_jellyfin'
       )
     ORDER BY created_at DESC
     LIMIT $1
  `, [bounded]);

  return result.rows.map(row => {
    const metadata = row.metadata || {};
    const action = String(row.action || '');
    const failed = action.endsWith('remove_failed');
    const dryRun = action.endsWith('would_remove_jellyfin');
    const label = failed ? 'Free inactivity removal failed' : dryRun ? 'Free inactivity would remove' : 'Free Jellyfin account removed';
    const bits = [];
    if (metadata.planCode) bits.push(metadata.planCode);
    if (Number.isFinite(Number(metadata.playbackMinutes))) bits.push(`${Number(metadata.playbackMinutes)} min playback`);
    if (Array.isArray(metadata.triggers) && metadata.triggers.length) bits.push(metadata.triggers.slice(0, 2).join(' · '));
    return {
      kind: failed ? 'bad' : dryRun ? 'warn' : 'good',
      label,
      detail: bits.join(' · ') || 'Free Server inactivity policy',
      at: row.created_at,
      href: row.entity_id ? `/admin/users/${encodeURIComponent(row.entity_id)}` : '/admin/automation'
    };
  });
}

function recentJobActions(rows, limit = 5) {
  return (rows || [])
    .filter(row => RECENT_JOB_KEYS.has(String(row.job_key || '')) && (row.last_completed_at || row.last_success_at))
    .map(row => {
      const outcome = String(row.last_outcome || '').toLowerCase();
      const failed = Math.max(0, Number(row.last_failed_count || 0));
      const processed = outcome === 'failed'
        ? 0
        : row.last_processed_count == null ? 0 : Math.max(0, Number(row.last_processed_count) || 0);
      if (!processed && !failed && !['failed','warning'].includes(outcome)) return null;
      const details = [];
      if (processed) details.push(`${processed} processed`);
      if (failed) details.push(`${failed} failed`);
      if (outcome === 'warning' && row.last_warning) details.push('completed with warnings');
      return {
        kind: outcome === 'failed' ? 'bad' : outcome === 'warning' || failed ? 'warn' : 'good',
        label: jobLabel(row.job_key),
        detail: details.join(' · ') || outcome || 'completed',
        at: row.last_completed_at || row.last_success_at,
        href: '/admin/automation'
      };
    })
    .filter(Boolean)
    .sort((a, b) => dateMs(b.at) - dateMs(a.at))
    .slice(0, Math.max(1, Number(limit) || 5));
}

async function recentAutomation(rows) {
  const audit = await inactivityAuditActions(4).catch(() => []);
  const combined = [...audit, ...recentJobActions(rows, 6)]
    .sort((a, b) => dateMs(b.at) - dateMs(a.at));
  const seen = new Set();
  return combined.filter(item => {
    const key = `${item.label}:${dateMs(item.at)}:${item.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

async function safePart(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(`Dashboard ${name} snapshot unavailable:`, cleanError(error));
    return { unavailable: true, error: cleanError(error) };
  }
}

async function controlCenterData() {
  let jobRows = null;
  let automationError = null;
  try {
    jobRows = await jobHealth.list();
  } catch (error) {
    automationError = cleanError(error);
    console.warn('Dashboard automation snapshot unavailable:', automationError);
  }
  const [free, commerce, recent] = await Promise.all([
    safePart('Free Server', () => freeSnapshot(jobRows)),
    safePart('billing integrity', billingSnapshot),
    jobRows == null ? Promise.resolve({ unavailable: true, error: automationError }) : safePart('recent automation', () => recentAutomation(jobRows))
  ]);
  return {
    automation: jobRows == null
      ? { unavailable: true, error: automationError, total: 0, healthy: 0, running: 0, disabled: 0, warningCount: 0, latestCriticalCompletedAt: null, warnings: [] }
      : automationSnapshot(jobRows),
    free,
    commerce,
    recent: Array.isArray(recent) ? recent : [],
    recentUnavailable: Boolean(recent?.unavailable)
  };
}

function automationHeroCard(snapshot = {}) {
  if (snapshot.unavailable) {
    return `<a class="profitHeroCard bad" href="/admin/automation"><span>Automation</span><strong>Unavailable</strong><small>${esc(snapshot.error || 'Job health could not be read.')}</small></a>`;
  }
  const total = Number(snapshot.total || 0);
  const healthy = Number(snapshot.healthy || 0);
  const running = Number(snapshot.running || 0);
  const warnings = Number(snapshot.warningCount || 0);
  const disabled = Number(snapshot.disabled || 0);
  const tone = warnings ? 'bad' : total ? 'good' : 'neutral';
  const states = [
    healthy ? `${healthy} healthy` : null,
    running ? `${running} running` : null,
    disabled ? `${disabled} paused` : null
  ].filter(Boolean).join(' · ');
  const headline = !total ? 'Unavailable' : warnings ? `${warnings} need review` : 'Healthy';
  const detail = [states, total ? `last job ${ageLabel(snapshot.latestCriticalCompletedAt)}` : null].filter(Boolean).join(' · ');
  return `<a class="profitHeroCard ${tone}" href="/admin/automation"><span>Automation</span><strong>${esc(headline)}</strong><small>${esc(detail)}</small></a>`;
}

function metric(label, value, detail = '') {
  return `<div class="dashboardControlMetric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
}

function freeCard(data = {}) {
  if (data.unavailable) {
    return `<a class="dashboardControlCard bad" href="/admin/servers"><div class="dashboardControlHead"><span>Free Server</span><strong>Unavailable</strong></div><p>${esc(data.error || 'Status could not be read.')}</p></a>`;
  }
  if (!data.configured) {
    return `<a class="dashboardControlCard neutral" href="/admin/plans"><div class="dashboardControlHead"><span>Free Server</span><strong>Not configured</strong></div><p>No active direct Free Jellyfin plan was found.</p></a>`;
  }
  const capacity = data.limit == null
    ? `${data.available ?? '—'} available`
    : `${data.used == null ? Math.max(0, Number(data.limit || 0) - Number(data.available || 0) - Number(data.reserved || 0)) : Number(data.used)} / ${data.limit}`;
  const inactivityBad = data.inactivityEnabled && ['failed','degraded','stale','missing','unavailable','disabled','never_run'].includes(data.inactivityState);
  const tone = inactivityBad ? 'warn' : (!data.inactivityEnabled || data.inactivityDryRun ? 'neutral' : 'good');
  const waitingLabel = data.waitingCapped ? `${Number(data.waiting || 0)}+` : String(data.waiting || 0);
  return `<a class="dashboardControlCard ${tone}" href="/admin/servers"><div class="dashboardControlHead"><span>Free Server</span><strong>${esc(data.available == null ? 'Capacity unavailable' : `${data.available} open`)}</strong></div><div class="dashboardControlMetrics">${metric('Capacity', capacity, data.limit == null ? '' : `used / eligible capacity · ${Number(data.reserved || 0)} reserved`)}${metric('Waiting', waitingLabel, 'awaiting a Free account')}${metric('Buffered advert', String(data.bufferedPlaces || 0), data.nextAdvert || '')}</div><p><strong>Inactivity:</strong> ${esc(data.inactivityEnabled ? (data.inactivityDryRun ? 'Dry run' : data.inactivityState) : 'Paused')} · last cycle ${esc(ageLabel(data.inactivityLastCompletedAt))}</p></a>`;
}

function billingCard(data = {}) {
  if (data.unavailable) {
    return `<a class="dashboardControlCard bad" href="/admin/billing"><div class="dashboardControlHead"><span>Billing integrity</span><strong>Unavailable</strong></div><p>${esc(data.error || 'Billing status could not be read.')}</p></a>`;
  }
  const needsReview = Boolean(data.needsReview);
  return `<a class="dashboardControlCard ${needsReview ? 'warn' : 'good'}" href="/admin/billing"><div class="dashboardControlHead"><span>Billing integrity</span><strong>${needsReview ? 'Needs review' : 'Clear'}</strong></div><div class="dashboardControlMetrics">${metric('Missing link', String(data.missing || 0))}${metric('Sync / events', String((data.syncProblems || 0) + (data.providerEventErrors || 0)))}${metric('Past due', String(data.pastDue || 0))}</div></a>`;
}

function recentFeed(items = [], unavailable = false) {
  const rows = (items || []).map(item => `<a class="dashboardAutomationEvent" href="${esc(item.href || '/admin/automation')}"><i class="${esc(item.kind || 'good')}" aria-hidden="true"></i><span><strong>${esc(item.label)}</strong><small>${esc(item.detail || '')}</small></span><time>${esc(ageLabel(item.at))}</time></a>`).join('');
  return `<section class="dashboardAutomationFeed"><div class="dashboardControlHead"><span>What Fin Fusion just did</span><a href="/admin/automation">Open automation</a></div>${unavailable ? '<p class="dashboardControlEmpty">Recent automation history is temporarily unavailable.</p>' : rows || '<p class="dashboardControlEmpty">No recent automation outcomes recorded.</p>'}</section>`;
}

function renderControlCenter(data = {}) {
  return `<section class="dashboardControlCenter" aria-label="Operational control centre"><div class="dashboardControlGrid">${freeCard(data.free)}${billingCard(data.commerce)}</div>${recentFeed(data.recent, data.recentUnavailable)}</section>`;
}

module.exports = {
  JOB_LABELS,
  RECENT_JOB_KEYS,
  ageLabel,
  jobLabel,
  automationSnapshot,
  nextAdvertLabel,
  freeSnapshot,
  billingSnapshot,
  recentJobActions,
  recentAutomation,
  controlCenterData,
  automationHeroCard,
  renderControlCenter
};
