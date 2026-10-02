'use strict';

const DEFAULT_INTERVAL_SECONDS = 300;

const JOB_METADATA = Object.freeze({
  health: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  entitlements: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  free_capacity_backfill: { defaultIntervalSeconds: 30, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  policy_drift: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  customer_inactivity: { defaultIntervalSeconds: 300, critical: true, disableableCritical: true, timeoutMs: null, concurrencyClass: 'shared' },
  customer_deletions: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  creation_intent_recovery: { defaultIntervalSeconds: 60, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  customer_service_recovery: { defaultIntervalSeconds: 60, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  revenue_integrity: { defaultIntervalSeconds: 60, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  provider_financial_reconciliation: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  notification_lifecycle: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  admin_activity_notifications: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  free_places_digest: { defaultIntervalSeconds: 30, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  data_retention: { defaultIntervalSeconds: 3600, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  bulk_jobs: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  stale_reclaim: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  email_outbox: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  notification_outbox: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  discord_roles: { defaultIntervalSeconds: 43200, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  request_users: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  billing: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  subscription_discovery: { defaultIntervalSeconds: 21600, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  provider_checkout_recovery: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  provider_operation_recovery: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  payment_events: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  plan_changes: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  referral_rewards: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  marketing_campaigns: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  winback_offers: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  activation_cleanup: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  pending_registration_cleanup: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' },
  stremio_managed_accounts: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  stremio_external_tokens: { defaultIntervalSeconds: 300, critical: true, timeoutMs: null, concurrencyClass: 'shared' },
  stremio_media_index: { defaultIntervalSeconds: 300, critical: false, timeoutMs: null, concurrencyClass: 'shared' }
});

function names() {
  return Object.keys(JOB_METADATA);
}

function get(jobKey) {
  return JOB_METADATA[String(jobKey || '')] || null;
}

function criticalNames() {
  return names().filter(jobKey => JOB_METADATA[jobKey].critical);
}

function disableableCriticalNames() {
  return names().filter(jobKey => JOB_METADATA[jobKey].disableableCritical);
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  JOB_METADATA,
  names,
  get,
  criticalNames,
  disableableCriticalNames
};
