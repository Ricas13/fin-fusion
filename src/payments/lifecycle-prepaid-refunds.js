'use strict';

const { transaction } = require('../db');
const carriedTime = require('./carried-time');
const accessExtensions = require('./subscription-access-extensions');

function dateMs(value, label) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`${label} is unavailable.`);
  return ms;
}

async function applyPrepaidRefund({ subscriptionId, customerId, originalEnd, cutoffAt, serviceType }) {
  return transaction(async client => {
    // One lock order everywhere: the customer, then the subscription.
    await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
    const result = await client.query(`
      SELECT s.*,s.current_period_end::text AS period_end_exact,p.service_type
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE s.id=$1 AND s.customer_id=$2
      FOR UPDATE OF s
    `, [subscriptionId, customerId]);
    const row = result.rows[0];
    if (!row) throw new Error('Refunded prepaid subscription no longer exists.');

    const originalEndMs = dateMs(originalEnd, 'Original service end');
    const cutoffMs = dateMs(cutoffAt, 'Refund cutoff');
    const startsMs = dateMs(row.starts_at, 'Subscription start');
    const observedEndMs = dateMs(row.current_period_end, 'Current service end');
    if (cutoffMs > originalEndMs) throw new Error('Refund cutoff exceeds the original service end.');
    if (observedEndMs > originalEndMs) throw new Error('Prepaid entitlement was extended after the refund was planned; manual review is required.');

    const observedEndDate = new Date(observedEndMs);
    const cutoffDate = new Date(cutoffMs);
    const effectiveServiceType = String(serviceType || row.service_type_snapshot || row.service_type || 'jellyfin');

    // A fully unused future refund can be reconciled first by the canonical
    // payment_incident trigger when the provider webhook races this operation.
    // That trigger expires this row and compacts the queue atomically. Detect
    // that committed state before deriving removedMs so recovery can never
    // compact the same later prepaid periods a second time.
    if (String(row.status || '').toLowerCase() === 'expired' && cutoffMs === startsMs) {
      const incident = await client.query(`
        SELECT 1
        FROM payment_incidents
        WHERE customer_id=$1
          AND provider=$2
          AND provider_subscription_id=$3
          AND incident_type='refund'
          AND COALESCE((metadata->>'fullRefund')::boolean,FALSE)=TRUE
        LIMIT 1
      `, [row.customer_id, row.source, row.provider_subscription_id]);
      if (incident.rowCount) {
        return {
          row,
          removedMs:0,
          cutoffAt:cutoffDate,
          observedEnd:observedEndDate,
          serviceType:effectiveServiceType,
          alreadyAppliedByIncident:true
        };
      }
    }

    // Recovery may re-enter after the entitlement transaction committed but
    // before provider_operations reached local_applied. Only remove the span
    // still present locally, so queued periods can never be shifted twice.
    const removedMs = Math.max(0, observedEndMs - cutoffMs);

    if (removedMs > 0 && row.superseded_by && row.replacement_reason === 'paid_time_carried') {
      // The time now sits on a newer plan. Take exactly the refunded base span
      // off it, leaving separately bought extension days where they are.
      await carriedTime.reduceSource(client, row.id, removedMs / 1000, { basePayment: true, reason: 'source_prorata_refund' });
      await client.query(`
        UPDATE subscriptions
        SET current_period_end=$2,status='expired',updated_at=NOW()
        WHERE id=$1
      `, [row.id, cutoffDate]);
    } else if (removedMs > 0) {
      await client.query(`
        UPDATE subscriptions
        SET current_period_end=$2,status='expired',service_extension_days=0,updated_at=NOW()
        WHERE id=$1
      `, [row.id, cutoffDate]);

      // A pro-rata refund pays back the base contract, not separately bought
      // extensions. Rebase only active purchase records from the new base end;
      // the reset above deliberately excludes unrelated/manual extra days.
      const rebased = await accessExtensions.recomputeActivePurchasedDaysTx(client,row.id,row.customer_id);
      const holder = rebased.subscription || row;
      // Later purchases move by the net reduction in the full access window,
      // never into an independently funded extension that survives this refund.
      // Keep exact SQL timestamps rather than losing queue boundaries in JS.
      await client.query(`
        SELECT public.pull_prepaid_queue(
          $1,$2,$3::timestamptz,
          GREATEST(0,EXTRACT(EPOCH FROM (
            ($3::timestamptz+make_interval(days=>$4::int))-
            (SELECT current_period_end+make_interval(days=>service_extension_days) FROM subscriptions WHERE id=$5)
          ))::numeric),
          $6,
          (SELECT current_period_end+make_interval(days=>service_extension_days) FROM subscriptions WHERE id=$5)
        )
      `, [row.customer_id, effectiveServiceType, row.period_end_exact || observedEndDate, Math.max(0, Number(row.service_extension_days || 0)), holder.id, row.id]);
    }

    return { row, removedMs, cutoffAt:cutoffDate, observedEnd:observedEndDate, serviceType:effectiveServiceType };
  });
}

module.exports = { applyPrepaidRefund };
