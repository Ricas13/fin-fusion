'use strict';

const { transaction } = require('../db');

function dateMs(value, label) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`${label} is unavailable.`);
  return ms;
}

async function applyPrepaidRefund({ subscriptionId, customerId, originalEnd, cutoffAt, serviceType }) {
  return transaction(async client => {
    const result = await client.query(`
      SELECT s.*,p.service_type
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE s.id=$1 AND s.customer_id=$2
      FOR UPDATE OF s
    `, [subscriptionId, customerId]);
    const row = result.rows[0];
    if (!row) throw new Error('Refunded prepaid subscription no longer exists.');

    const originalEndMs = dateMs(originalEnd, 'Original service end');
    const cutoffMs = dateMs(cutoffAt, 'Refund cutoff');
    const observedEndMs = dateMs(row.current_period_end, 'Current service end');
    if (cutoffMs > originalEndMs) throw new Error('Refund cutoff exceeds the original service end.');
    if (observedEndMs > originalEndMs) throw new Error('Prepaid entitlement was extended after the refund was planned; manual review is required.');

    // Recovery may re-enter after the entitlement transaction committed but
    // before provider_operations reached local_applied. Only remove the span
    // still present locally, so queued periods can never be shifted twice.
    const removedMs = Math.max(0, observedEndMs - cutoffMs);
    const observedEndDate = new Date(observedEndMs);
    const cutoffDate = new Date(cutoffMs);
    const effectiveServiceType = String(serviceType || row.service_type_snapshot || row.service_type || 'jellyfin');

    if (removedMs > 0) {
      await client.query(`
        UPDATE subscriptions
        SET current_period_end=$2,status='expired',service_extension_days=0,updated_at=NOW()
        WHERE id=$1
      `, [row.id, cutoffDate]);

      await client.query(`
        UPDATE subscriptions queued
        SET starts_at=queued.starts_at-($4::bigint * INTERVAL '1 millisecond'),
            current_period_end=queued.current_period_end-($4::bigint * INTERVAL '1 millisecond'),
            updated_at=NOW()
        FROM plans qp
        WHERE queued.plan_id=qp.id
          AND queued.customer_id=$1
          AND queued.id<>$2
          AND queued.superseded_by IS NULL
          AND queued.starts_at >= $3
          AND queued.status IN ('active','trialing','past_due','paused','cancelled')
          AND queued.source IN ('stripe','paypal','plisio')
          AND NOT (queued.source='stripe' AND COALESCE(queued.provider_subscription_id,'') ~* '^sub_')
          AND NOT (queued.source='paypal' AND COALESCE(queued.provider_subscription_id,'') ~* '^I-')
          AND (
            COALESCE(queued.service_type_snapshot,qp.service_type,'jellyfin')='bundle'
            OR $5='bundle'
            OR COALESCE(queued.service_type_snapshot,qp.service_type,'jellyfin')=$5
          )
      `, [row.customer_id, row.id, observedEndDate, removedMs, effectiveServiceType]);
    }

    return { row, removedMs, cutoffAt:cutoffDate, observedEnd:observedEndDate, serviceType:effectiveServiceType };
  });
}

module.exports = { applyPrepaidRefund };
