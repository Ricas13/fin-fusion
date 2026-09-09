'use strict';

const { query } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const subscriptionState = require('../entitlements/subscription-state');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
}

async function pendingClaimCandidates(limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await query(`
    SELECT r.id AS reservation_id,
           r.customer_id,
           r.plan_id,
           r.pending_registration_id,
           r.expires_at,
           r.created_at
    FROM free_access_registration_reservations r
    JOIN pending_registrations p ON p.id=r.pending_registration_id
    JOIN customers c ON c.id=r.customer_id
    WHERE r.customer_id IS NOT NULL
      AND r.subscription_id IS NULL
      AND r.consumed_at IS NULL
      AND r.released_at IS NULL
      AND r.expires_at>NOW()
      AND p.consumed_at IS NOT NULL
      AND c.user_id IS NOT NULL
    ORDER BY r.created_at ASC,r.id ASC
    LIMIT $1
  `, [bounded]);
  return result.rows;
}

async function waitingCandidates(limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await query(`
    WITH current_free AS (
      SELECT DISTINCT ON (s.customer_id)
             s.customer_id,
             s.id AS subscription_id,
             p.id AS plan_id,
             s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      JOIN customers c ON c.id=s.customer_id
      LEFT JOIN customer_entitlement_overrides o
        ON o.customer_id=s.customer_id AND o.subscription_id=s.id
      WHERE p.is_free_tier=TRUE
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND c.access_paused_at IS NULL
        AND (
          (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
          OR public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
          OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
          OR (
            COALESCE(s.service_extension_days,0)>0
            AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
            AND (s.current_period_end+((s.service_extension_days||' days')::interval))>NOW()
          )
        )
        AND NOT EXISTS(
          SELECT 1
          FROM jellyfin_accounts ja
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND ja.access_lane='free'
            AND ja.disabled=FALSE
        )
      ORDER BY s.customer_id,s.created_at DESC,s.id DESC
    )
    SELECT customer_id,subscription_id,plan_id,created_at
    FROM current_free
    ORDER BY created_at ASC,customer_id ASC
    LIMIT $1
  `, [bounded]);
  return result.rows;
}

async function retryVerifiedClaims(limit = 100) {
  const rows = await pendingClaimCandidates(limit);
  let attempted = 0;
  let activated = 0;
  let failed = 0;
  const failures = [];

  for (const row of rows) {
    attempted += 1;
    try {
      // Lazy-load lifecycle to keep the automation module independent from the
      // payment module's startup graph. claimFreePlan is idempotent at the
      // reservation row because it locks and consumes that reservation in the
      // same transaction as the subscription insert.
      const lifecycle = require('../payments/lifecycle');
      await lifecycle.claimFreePlan(row.customer_id, null, { reservationId: row.reservation_id });
      activated += 1;
    } catch (error) {
      // Another worker may have won the reservation lock, or claimFreePlan may
      // have committed the entitlement before a downstream provisioning call
      // failed. In either case the durable claim already exists and this retry
      // must converge instead of reporting a false failure.
      const current = (await query(`
        SELECT consumed_at,released_at,subscription_id
        FROM free_access_registration_reservations
        WHERE id=$1
      `, [row.reservation_id])).rows[0] || null;
      if (!current || current.consumed_at || current.released_at || current.subscription_id) {
        activated += 1;
        continue;
      }
      failed += 1;
      failures.push(String(error?.message || error || 'Unknown Free Access claim retry failure').slice(0, 300));
      console.error('Verified Free Access claim retry failed.', {
        customerId: row.customer_id,
        reservationId: row.reservation_id,
        planId: row.plan_id,
        error: error.message
      });
    }
  }

  return { total: rows.length, attempted, activated, failed, failures };
}

async function run({ limit = 100 } = {}) {
  // First finish any verified registration whose immediate Free claim failed
  // before commit. This consumes the customer's already-reserved capacity; it
  // does not compete with ordinary waiting users for a fresh slot.
  const claimRetries = await retryVerifiedClaims(limit);
  const rows = await waitingCandidates(limit);
  let attempted = 0;
  let assigned = 0;
  let waiting = 0;
  let skipped = 0;
  let failed = claimRetries.failed;
  const exhaustedPlans = new Set();
  const failures = [...claimRetries.failures];

  for (const row of rows) {
    const planKey = String(row.plan_id || '');
    if (exhaustedPlans.has(planKey)) {
      waiting += 1;
      continue;
    }

    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(row.customer_id, { includeBlocked: true });
    if (!entitlement || entitlement.blocked) {
      skipped += 1;
      continue;
    }

    attempted += 1;
    try {
      const outcome = await provisioning.reconcileCustomer(row.customer_id);
      if (outcome?.free?.active && outcome?.free?.account && !outcome.free.account.disabled) {
        assigned += 1;
      } else {
        waiting += 1;
      }
    } catch (error) {
      if (noCapacity(error)) {
        // Reconciliation is deliberately sequential. Once one candidate proves
        // this plan has no eligible user slot left, do not hammer every other
        // waiting applicant in the same pass. The next short backfill run will
        // retry after capacity changes.
        exhaustedPlans.add(planKey);
        waiting += 1;
        continue;
      }
      failed += 1;
      failures.push(String(error?.message || error || 'Unknown Free Server backfill failure').slice(0, 300));
      console.error('Free Server capacity backfill failed for customer.', {
        customerId: row.customer_id,
        subscriptionId: row.subscription_id,
        planId: row.plan_id,
        error: error.message
      });
    }
  }

  return {
    total: rows.length + claimRetries.total,
    processed: attempted + claimRetries.attempted,
    attempted,
    assigned,
    waiting,
    skipped,
    failed,
    claimRetries: {
      attempted: claimRetries.attempted,
      activated: claimRetries.activated,
      failed: claimRetries.failed
    },
    ...(failures.length ? { warning: failures.slice(0, 2).join('; ') } : {})
  };
}

module.exports = { pendingClaimCandidates, retryVerifiedClaims, waitingCandidates, run, noCapacity };