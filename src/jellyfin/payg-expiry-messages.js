'use strict';

const { getPool, query } = require('../db');
const registry = require('./registry');
const operationsSettings = require('../platform/operations-settings');
const mediaPlanPolicy = require('./media-plan-policy-settings');

const REMINDER_ADVISORY_LOCK_ID = 637441017;
const SENT_REASON = 'payg_expiry_reminder_sent';
const FAILED_REASON = 'payg_expiry_reminder_failed';
const REMINDER_DAYS = new Set([7, 1, 0]);
const STREAM_AGE_SECONDS = 30;

function lane(value) { return String(value || '') === 'free' ? 'free' : 'primary'; }
function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const read = type => parts.find(part => part.type === type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}
function dateNumber(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}
function reminderDay(expiresAt, now, timeZone) {
  return dateNumber(dateKey(expiresAt, timeZone)) - dateNumber(dateKey(now, timeZone));
}
function messageFor(days, expiresAt, timeZone) {
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(expiresAt);
  if (days === 7) return `Your Pay As You Go access ends in 7 days (${date}). Renew in your customer portal to keep watching without interruption.`;
  if (days === 1) return `Your Pay As You Go access ends tomorrow (${date}). Renew in your customer portal to keep watching without interruption.`;
  return `Your Pay As You Go access ends today (${date}). Renew in your customer portal to keep watching without interruption.`;
}

async function candidates() {
  const result = await query(`
    SELECT aps.server_id,aps.jellyfin_session_id,aps.jellyfin_account_id,aps.customer_id,aps.first_seen_at,
           ja.access_lane,
           ent.subscription_id,ent.plan_id,ent.access_expires_at
    FROM active_playback_sessions aps
    JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id
    JOIN LATERAL (
      SELECT s.id AS subscription_id,s.plan_id,
             s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval) AS access_expires_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
      WHERE s.customer_id=aps.customer_id
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
        AND CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END = CASE WHEN ja.access_lane='free' THEN 'free' ELSE 'primary' END
        AND NOT (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
        AND s.source IN ('stripe','paypal')
        AND s.provider_subscription_id IS NULL
        AND (
          (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
          OR (COALESCE(s.service_extension_days,0)>0
              AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
              AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
        )
      ORDER BY access_expires_at DESC,s.created_at DESC
      LIMIT 1
    ) ent ON TRUE
    WHERE ja.account_purpose='jellyfin'
      AND ja.disabled=FALSE
      AND aps.first_seen_at<=NOW()-($1::int*INTERVAL '1 second')
    ORDER BY ent.subscription_id,aps.first_seen_at,aps.jellyfin_session_id
  `, [STREAM_AGE_SECONDS]);
  const firstBySubscription = new Map();
  for (const row of result.rows) {
    const key = String(row.subscription_id);
    if (!firstBySubscription.has(key)) firstBySubscription.set(key, row);
  }
  return [...firstBySubscription.values()];
}

async function alreadySent(subscriptionId, deliveryDate) {
  const result = await query(`
    SELECT 1 FROM stream_policy_events
    WHERE reason=$1 AND detail->>'subscriptionId'=$2 AND detail->>'deliveryDate'=$3
    LIMIT 1
  `, [SENT_REASON, String(subscriptionId), String(deliveryDate)]);
  return result.rowCount > 0;
}

async function recentlyFailed(subscriptionId, deliveryDate) {
  const result = await query(`
    SELECT 1 FROM stream_policy_events
    WHERE reason=$1 AND detail->>'subscriptionId'=$2 AND detail->>'deliveryDate'=$3
      AND created_at>NOW()-INTERVAL '10 minutes'
    LIMIT 1
  `, [FAILED_REASON, String(subscriptionId), String(deliveryDate)]);
  return result.rowCount > 0;
}

async function event(row, decision, reason, detail) {
  await query(`
    INSERT INTO stream_policy_events(customer_id,server_id,jellyfin_account_id,jellyfin_session_id,mode,decision,stream_count,stream_limit,reason,detail)
    VALUES($1,$2,$3,$4,'observe',$5,NULL,NULL,$6,$7::jsonb)
  `, [row.customer_id,row.server_id,row.jellyfin_account_id,row.jellyfin_session_id,decision,reason,
    JSON.stringify({ planId: String(row.plan_id), subscriptionId: String(row.subscription_id), accessLane: lane(row.access_lane), ...detail })]);
}

async function runPaygExpiryMessageCycle({ failedServerIds = [] } = {}) {
  const pool = getPool();
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [REMINDER_ADVISORY_LOCK_ID]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { skipped: true, reason: 'another_payg_reminder_cycle_is_running' };

    const failedServers = new Set((failedServerIds || []).map(String));
    const now = new Date();
    const operations = await operationsSettings.get();
    const timeZone = operations.timezone || 'Europe/London';
    const rows = await candidates();
    const policies = await mediaPlanPolicy.getMany(rows.map(row => row.plan_id));
    const summary = { skipped: false, eligible: 0, sent: 0, failed: 0, safetySkipped: 0 };

    for (const row of rows) {
      if (failedServers.has(String(row.server_id))) {
        summary.safetySkipped += 1;
        continue;
      }
      const policy = policies.get(String(row.plan_id)) || mediaPlanPolicy.DEFAULTS;
      if (policy.paygExpiryMessagesEnabled === false) continue;
      const expiresAt = new Date(row.access_expires_at);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) continue;
      const days = reminderDay(expiresAt, now, timeZone);
      if (!REMINDER_DAYS.has(days)) continue;
      summary.eligible += 1;
      const deliveryDate = dateKey(now, timeZone);
      if (await alreadySent(row.subscription_id, deliveryDate)) continue;
      if (await recentlyFailed(row.subscription_id, deliveryDate)) continue;

      try {
        await registry.request(row.server_id, `/Sessions/${encodeURIComponent(row.jellyfin_session_id)}/Message`, {
          method: 'POST', timeoutMs: 5000,
          body: { Header: 'Pay As You Go access ending', Text: messageFor(days, expiresAt, timeZone), TimeoutMs: 12000 }
        });
        await event(row, 'observed', SENT_REASON, { reminderDay: days, deliveryDate, expiresAt: expiresAt.toISOString() });
        summary.sent += 1;
      } catch (error) {
        await event(row, 'skipped_safety', FAILED_REASON, { reminderDay: days, deliveryDate, expiresAt: expiresAt.toISOString(), error: String(error.message || error).slice(0, 900) });
        summary.failed += 1;
      }
    }
    return summary;
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [REMINDER_ADVISORY_LOCK_ID]); } catch (_) {}
    }
    client.release();
  }
}

module.exports = {
  REMINDER_ADVISORY_LOCK_ID,
  SENT_REASON,
  FAILED_REASON,
  REMINDER_DAYS,
  STREAM_AGE_SECONDS,
  dateKey,
  reminderDay,
  messageFor,
  runPaygExpiryMessageCycle
};
