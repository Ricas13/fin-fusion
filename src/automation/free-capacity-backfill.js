'use strict';

const { query } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const subscriptionState = require('../entitlements/subscription-state');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
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

async function run({ limit = 100 } = {}) {
  const rows = await waitingCandidates(limit);
  let attempted = 0;
  let assigned = 0;
  let waiting = 0;
  let skipped = 0;
  let failed = 0;
  const exhaustedPlans = new Set();
  const failures = [];

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
    total: rows.length,
    processed: attempted,
    attempted,
    assigned,
    waiting,
    skipped,
    failed,
    ...(failures.length ? { warning: failures.slice(0, 2).join('; ') } : {})
  };
}

module.exports = { waitingCandidates, run, noCapacity };
