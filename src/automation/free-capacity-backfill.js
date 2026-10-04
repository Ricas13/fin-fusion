'use strict';

const { query } = require('../db');
const accessRepair = require('../access/access-repair');
const planCapacity = require('../entitlements/plan-capacity');
const freeReadiness = require('../jellyfin/free-claim-readiness');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
}

async function pendingClaimCandidates(limit = 100, options = {}) {
  const planId = options?.planId || null;
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const planFilter = planId ? 'AND r.plan_id=$2::uuid' : '';
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
      ${planFilter}
    ORDER BY r.created_at ASC,r.id ASC
    LIMIT $1
  `, planId ? [bounded, planId] : [bounded]);
  return result.rows;
}

async function orphanAccountCandidates(limit = 100) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await query(`
    SELECT DISTINCT ja.customer_id
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.account_purpose='jellyfin'
      AND ja.access_lane='free'
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
      AND NOT EXISTS (
        SELECT 1
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        LEFT JOIN customer_entitlement_overrides o
          ON o.customer_id=s.customer_id AND o.subscription_id=s.id
        WHERE s.customer_id=ja.customer_id
          AND p.is_free_tier=TRUE
          AND COALESCE(p.is_addon,FALSE)=FALSE
          AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
          AND s.superseded_by IS NULL
          AND s.starts_at<=NOW()
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
      )
    ORDER BY ja.customer_id
    LIMIT $1
  `, [bounded]);
  return result.rows;
}

async function waitingCandidates(limit = 100, options = {}) {
  const planId = options?.planId || null;
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
  const planFilter = planId ? 'AND p.id=$2::uuid' : '';
  const result = await query(`
    WITH current_free AS (
      SELECT DISTINCT ON (s.customer_id)
             s.customer_id,
             s.id AS subscription_id,
             p.id AS plan_id,
             s.created_at
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_entitlement_overrides o
        ON o.customer_id=s.customer_id AND o.subscription_id=s.id
      WHERE p.is_free_tier=TRUE
        ${planFilter}
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
        AND ${planCapacity.freePendingUnblockedSql('s','free_pending_hold')}
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
          JOIN jellyfin_servers ready_js ON ready_js.id=ja.server_id
          WHERE ja.customer_id=s.customer_id
            AND ja.account_purpose='jellyfin'
            AND ja.access_lane='free'
            AND ja.disabled=FALSE
            AND ready_js.enabled=TRUE
            AND COALESCE(ready_js.media_server_type,'jellyfin')='jellyfin'
            AND (s.media_server_id IS NULL OR ja.server_id=s.media_server_id)
        )
      ORDER BY s.customer_id,s.created_at DESC,s.id DESC
    )
    SELECT customer_id,subscription_id,plan_id,created_at
    FROM current_free
    ORDER BY created_at ASC,customer_id ASC
    LIMIT $1
  `, planId ? [bounded, planId] : [bounded]);
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
      // A reservation row being consumed is no longer enough to call this
      // activated. The only success state is an enabled Free Server account.
      if (await freeReadiness.hasReadyFreeAccount(row.customer_id)) {
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
  // Verified registration reservations may still need their first claim
  // attempt after a process crash. claimFreePlan itself is now binary: it
  // returns only with an enabled Free account or rolls the Free plan back.
  const claimRetries = await retryVerifiedClaims(limit);

  // Repair any legacy/live Free entitlement that has no enabled Free account.
  // We may make one synchronous convergence attempt, but we never leave it in
  // a "deployment pending" state afterwards: success means server + plan;
  // failure means the incomplete Free plan is removed.
  const rows = await waitingCandidates(limit);
  const orphanAccounts = await orphanAccountCandidates(limit);
  let attempted = 0;
  let assigned = 0;
  let removed = 0;
  let orphanAccountsRemoved = 0;
  let skipped = 0;
  let failed = claimRetries.failed;
  const failures = [...claimRetries.failures];

  for (const row of rows) {
    attempted += 1;
    try {
      const result = await accessRepair.repairFreeEntitlement(row.customer_id, row.subscription_id, {
        reason: 'Legacy Free entitlement had no enabled Free Server account'
      });
      if (result.status === 'ready' || result.status === 'repaired') assigned += 1;
      else if (result.status === 'removed') removed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      failures.push(String(error?.message || error || 'Unknown Free Server orphan cleanup failure').slice(0, 300));
      console.error('Free Server orphan entitlement cleanup failed.', {
        customerId: row.customer_id,
        subscriptionId: row.subscription_id,
        planId: row.plan_id,
        error: error.message
      });
    }
  }

  for (const row of orphanAccounts) {
    try {
      const result = await accessRepair.removeOrphanFreeAccount(row.customer_id);
      if (result.status === 'removed') orphanAccountsRemoved += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      failures.push(String(error?.message || error || 'Unknown orphan Free account cleanup failure').slice(0, 300));
      console.error('Orphan Free Server account cleanup failed.', {
        customerId: row.customer_id,
        error: error.message
      });
    }
  }

  return {
    total: rows.length + claimRetries.total + orphanAccounts.length,
    processed: attempted + claimRetries.attempted + orphanAccounts.length,
    attempted,
    assigned,
    removed,
    orphanAccountsRemoved,
    waiting: 0,
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

module.exports = { pendingClaimCandidates, retryVerifiedClaims, orphanAccountCandidates, waitingCandidates, run, noCapacity };