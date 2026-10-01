'use strict';

const DEFAULT_INTERVAL_SECONDS = 300;

const JOB_METADATA = Object.freeze({
  health: { defaultIntervalSeconds: 300, critical: true },
  entitlements: { defaultIntervalSeconds: 300, critical: true },
  free_capacity_backfill: { defaultIntervalSeconds: 30, critical: true },
  policy_drift: { defaultIntervalSeconds: 300, critical: false },
  customer_inactivity: { defaultIntervalSeconds: 300, critical: true, disableableCritical: true },
  customer_deletions: { defaultIntervalSeconds: 300, critical: true },
  creation_intent_recovery: { defaultIntervalSeconds: 60, critical: true },
  customer_service_recovery: { defaultIntervalSeconds: 60, critical: true },
  revenue_integrity: { defaultIntervalSeconds: 60, critical: true },
  paypal_history_reconciliation: { defaultIntervalSeconds: 300, critical: false },
  notification_lifecycle: { defaultIntervalSeconds: 300, critical: true },
  admin_activity_notifications: { defaultIntervalSeconds: 300, critical: false },
  free_places_digest: { defaultIntervalSeconds: 30, critical: false },
  data_retention: { defaultIntervalSeconds: 3600, critical: false },
  bulk_jobs: { defaultIntervalSeconds: 300, critical: false },
  stale_reclaim: { defaultIntervalSeconds: 300, critical: false },
  email_outbox: { defaultIntervalSeconds: 300, critical: true },
  notification_outbox: { defaultIntervalSeconds: 300, critical: true },
  discord_roles: { defaultIntervalSeconds: 43200, critical: true },
  request_users: { defaultIntervalSeconds: 300, critical: false },
  billing: { defaultIntervalSeconds: 300, critical: true },
  subscription_discovery: { defaultIntervalSeconds: 21600, critical: true },
  provider_checkout_recovery: { defaultIntervalSeconds: 300, critical: true },
  provider_operation_recovery: { defaultIntervalSeconds: 300, critical: true },
  payment_events: { defaultIntervalSeconds: 300, critical: true },
  plan_changes: { defaultIntervalSeconds: 300, critical: true },
  referral_rewards: { defaultIntervalSeconds: 300, critical: false },
  marketing_campaigns: { defaultIntervalSeconds: 300, critical: false },
  winback_offers: { defaultIntervalSeconds: 300, critical: false },
  activation_cleanup: { defaultIntervalSeconds: 300, critical: true },
  pending_registration_cleanup: { defaultIntervalSeconds: 300, critical: false },
  stremio_managed_accounts: { defaultIntervalSeconds: 300, critical: true },
  stremio_external_tokens: { defaultIntervalSeconds: 300, critical: true },
  stremio_media_index: { defaultIntervalSeconds: 300, critical: false }
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
