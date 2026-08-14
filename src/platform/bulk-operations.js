'use strict';

// Per-item execution handlers for admin bulk customer operations (People ->
// Customers bulk action bar). Each handler is registered against
// src/jellyfin/bulk-worker.js's generic claim/retry/status-tracking loop, so
// none of them need to reimplement batching, idempotency or retry safety --
// they only need to perform one customer's mutation and return a JSON-safe
// result (never secrets/passwords/tokens, since results are stored and
// later rendered to admins).
//
// job.params carries the action-specific configuration chosen at "Preview ->
// Confirm" time (e.g. which libraries to add, which plan to switch to).
// Every handler re-validates params defensively -- params come from the
// same admin request that created the job, but are stored as JSONB and
// read back, so treat them like any other persisted, not-currently-trusted
// input. IDs referenced by params (plan, reseller) are re-checked to exist
// on every item, not assumed still valid from confirm time.

const { query } = require('../db');
const bulkWorker = require('../jellyfin/bulk-worker');
const provisioning = require('../jellyfin/provisioning');
const policy = require('../jellyfin/policy');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const lifecycle = require('../payments/lifecycle');

function registerHandler(jobType, fn) {
    bulkWorker.registerHandler(jobType, fn);
}

async function currentSubscription(customerId) {
    const result = await query(`
        SELECT * FROM subscriptions WHERE customer_id=$1
        ORDER BY current_period_end DESC,created_at DESC LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}

async function auditItem(action, customerId, metadata) {
    await query(`
        INSERT INTO audit_log(action,entity_type,entity_id,metadata)
        VALUES($1,'customer',$2,$3::jsonb)
    `, [action, customerId, JSON.stringify(metadata || {})]);
}

// ---- Libraries ----------------------------------------------------------

async function applyLibraryNames(customerId, names, mode) {
    const plan = await provisioning.currentEntitlement(customerId);
    if (!plan) throw new Error('Customer has no active plan');
    const catalog = await provisioning.libraryCatalogForServerClass(plan.server_class);
    // libraryOverridePlan is the single source of truth for what each mode
    // touches -- Add/Remove only ever produce entries for the requested
    // names, Replace is the only mode that can also produce entries for
    // libraries the admin didn't pick (to revoke them).
    const changes = policy.libraryOverridePlan(mode, names, catalog.names);
    for (const change of changes) await provisioning.setLibraryOverride(customerId, change.name, change.granted, null);
    await provisioning.reconcileCustomer(customerId);
    return { libraries: changes.map(c => c.name) };
}

registerHandler('library_add', async item => {
    const result = await applyLibraryNames(item.customer_id, item.params?.libraryNames || [], 'add');
    await auditItem('admin.bulk.library_add', item.customer_id, result);
    return result;
});
registerHandler('library_remove', async item => {
    const result = await applyLibraryNames(item.customer_id, item.params?.libraryNames || [], 'remove');
    await auditItem('admin.bulk.library_remove', item.customer_id, result);
    return result;
});
registerHandler('library_replace', async item => {
    const result = await applyLibraryNames(item.customer_id, item.params?.libraryNames || [], 'replace');
    await auditItem('admin.bulk.library_replace', item.customer_id, result);
    return result;
});
registerHandler('library_reset', async item => {
    await provisioning.resetAllLibraryOverrides(item.customer_id);
    await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.library_reset', item.customer_id, {});
    return {};
});

// ---- Plan / entitlement --------------------------------------------------

registerHandler('plan_change', async item => {
    const planId = String(item.params?.planId || '');
    const planResult = await query('SELECT * FROM plans WHERE id=$1 AND active=TRUE', [planId]);
    if (!planResult.rowCount) throw new Error('Target plan not found or inactive');
    const sub = await currentSubscription(item.customer_id);
    if (!sub) throw new Error('Customer has no subscription to change');
    await query(`UPDATE subscriptions SET plan_id=$2,updated_at=NOW() WHERE id=$1`, [sub.id, planId]);
    await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.plan_change', item.customer_id, { planId });
    return { planId };
});

// Idempotent across retries: "extend by N units from wherever current_period_end
// happens to be right now" is NOT safe to simply re-run, since a retry after
// an uncertain outcome (crash, stale-running reclaim, explicit Retry Failed)
// could extend twice if the first attempt actually committed before failing
// to report success. The target expiry is computed once and persisted to
// previous_state before mutating; every subsequent attempt for this same job
// item reuses that persisted target instead of recomputing from the
// (possibly already-mutated) current value.
registerHandler('extend_entitlement', async item => {
    const units = Number(item.params?.units) || 1;
    const sub = await currentSubscription(item.customer_id);
    if (!sub) throw new Error('Customer has no subscription to extend');

    let targetExpiry;
    if (item.previous_state?.targetExpiry) {
        targetExpiry = new Date(item.previous_state.targetExpiry);
    } else {
        const planResult = await query('SELECT duration_days FROM plans WHERE id=$1', [sub.plan_id]);
        const durationDays = Number(planResult.rows[0]?.duration_days) || 30;
        const base = new Date(sub.current_period_end) > new Date() ? new Date(sub.current_period_end) : new Date();
        targetExpiry = new Date(base.getTime() + durationDays * units * 86400000);
        await query(`UPDATE background_job_items SET previous_state=$2::jsonb WHERE id=$1`, [
            item.id,
            JSON.stringify({ targetExpiry: targetExpiry.toISOString(), originalExpiry: sub.current_period_end })
        ]);
    }

    await query(`UPDATE subscriptions SET current_period_end=$2,status=CASE WHEN status IN ('cancelled','expired') THEN 'active' ELSE status END,updated_at=NOW() WHERE id=$1`, [sub.id, targetExpiry]);
    await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.extend_entitlement', item.customer_id, { units, newExpiry: targetExpiry });
    return { newExpiry: targetExpiry };
});

registerHandler('set_expiry', async item => {
    const expiryDate = String(item.params?.expiryDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new Error('Invalid expiry date');
    const sub = await currentSubscription(item.customer_id);
    if (!sub) throw new Error('Customer has no subscription');
    await query(`UPDATE subscriptions SET current_period_end=$2::date,updated_at=NOW() WHERE id=$1`, [sub.id, expiryDate]);
    await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.set_expiry', item.customer_id, { expiryDate });
    return { expiryDate };
});

registerHandler('reset_overrides', async item => {
    await provisioning.resetAllPolicyOverrides(item.customer_id, null);
    await provisioning.resetAllLibraryOverrides(item.customer_id);
    await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.reset_overrides', item.customer_id, {});
    return {};
});

// ---- Customer state -------------------------------------------------------

// enable/disable/suspend all go through the same persistent, reversible
// access hold (customers.access_paused_at/access_hold_reason) rather than
// mutating subscription status -- disable/suspend must survive the periodic
// entitlement-reconcile sweep (which only looks at subscription state, so a
// direct Jellyfin-account disable would get silently undone), and enable
// must be able to restore exactly the prior state without having to guess
// what subscription status to resume to.
registerHandler('enable', async item => {
    const outcome = await provisioning.releaseAccess(item.customer_id);
    await auditItem('admin.bulk.enable', item.customer_id, { active: Boolean(outcome?.active) });
    return { active: Boolean(outcome?.active) };
});

registerHandler('disable', async item => {
    const outcome = await provisioning.holdAccess(item.customer_id, 'disabled');
    await auditItem('admin.bulk.disable', item.customer_id, { active: Boolean(outcome?.active) });
    return { active: Boolean(outcome?.active) };
});

registerHandler('suspend', async item => {
    const outcome = await provisioning.holdAccess(item.customer_id, 'suspended');
    await auditItem('admin.bulk.suspend', item.customer_id, { active: Boolean(outcome?.active) });
    return { active: Boolean(outcome?.active) };
});

// ---- Jellyfin -------------------------------------------------------------

registerHandler('reconcile', async item => {
    const outcome = await provisioning.reconcileCustomer(item.customer_id);
    await auditItem('admin.bulk.reconcile', item.customer_id, { active: Boolean(outcome?.active) });
    return { active: Boolean(outcome?.active) };
});

registerHandler('retry_failed', async item => {
    const failed = await query(`
        SELECT jellyfin_account_id FROM jellyfin_policy_reconciliation
        WHERE customer_id=$1 AND status='failed'
    `, [item.customer_id]);
    let succeeded = 0;
    const errors = [];
    for (const row of failed.rows) {
        try { await provisioning.reconcileAccount(row.jellyfin_account_id); succeeded += 1; }
        catch (error) { errors.push(error.message); }
    }
    await auditItem('admin.bulk.retry_failed', item.customer_id, { attempted: failed.rows.length, succeeded, stillFailing: errors.length });
    // Nothing to retry is a legitimate success (failed.rows.length === 0);
    // anything still failing after the attempt must fail this job item too,
    // or Retry Failed would silently report success while accounts remain
    // in a failed reconciliation state.
    if (errors.length) throw new Error(`${errors.length}/${failed.rows.length} account(s) still failing after retry: ${errors[0]}`);
    return { succeeded };
});

registerHandler('revoke_sessions', async item => {
    const sessions = await query(`
        SELECT server_id,jellyfin_session_id FROM active_playback_sessions WHERE customer_id=$1
    `, [item.customer_id]);
    const registry = require('../jellyfin/registry');
    let revoked = 0;
    for (const session of sessions.rows) {
        try {
            await registry.request(session.server_id, `/Sessions/${encodeURIComponent(session.jellyfin_session_id)}/Logout`, { method: 'POST' });
            revoked += 1;
        } catch (_) { /* session may have already ended */ }
    }
    await query('DELETE FROM active_playback_sessions WHERE customer_id=$1', [item.customer_id]);
    await auditItem('admin.bulk.revoke_sessions', item.customer_id, { revoked });
    return { revoked };
});

// ---- Reseller ---------------------------------------------------------

registerHandler('reseller_assign', async item => {
    const resellerId = String(item.params?.resellerId || '');
    const resellerResult = await query('SELECT id FROM resellers WHERE id=$1', [resellerId]);
    if (!resellerResult.rowCount) throw new Error('Target reseller not found');
    await query('UPDATE customers SET reseller_id=$2 WHERE id=$1', [item.customer_id, resellerId]);
    await auditItem('admin.bulk.reseller_assign', item.customer_id, { resellerId });
    return { resellerId };
});

registerHandler('reseller_detach', async item => {
    await query('UPDATE customers SET reseller_id=NULL WHERE id=$1', [item.customer_id]);
    await auditItem('admin.bulk.reseller_detach', item.customer_id, {});
    return {};
});

// ---- Payments -------------------------------------------------------------

registerHandler('payments_sync', async item => {
    const subs = await query(`
        SELECT source,provider_subscription_id FROM subscriptions
        WHERE customer_id=$1 AND source IN ('stripe','paypal') AND provider_subscription_id IS NOT NULL
    `, [item.customer_id]);
    let synced = 0;
    const errors = [];
    for (const row of subs.rows) {
        try {
            if (row.source === 'stripe' && stripe.enabled()) {
                await stripe.syncSubscription(row.provider_subscription_id);
                synced += 1;
            } else if (row.source === 'paypal' && paypal.enabled()) {
                const remote = await paypal.getSubscription(row.provider_subscription_id);
                await lifecycle.updateProviderSubscription({
                    provider: 'paypal',
                    providerSubscriptionId: row.provider_subscription_id,
                    providerStatus: remote.status,
                    periodEnd: remote.billing_info?.next_billing_time || null
                });
                synced += 1;
            }
        } catch (error) {
            console.error(`Payment sync failed for ${item.customer_id}:`, error.message);
            errors.push(`${row.source}: ${error.message}`);
        }
    }
    await auditItem('admin.bulk.payments_sync', item.customer_id, { synced, failed: errors.length });
    // A customer with zero stripe/paypal subscriptions to sync is a
    // legitimate no-op success; a provider call that actually failed must
    // fail this job item, or the worker/UI would report success while the
    // stored subscription state is still stale.
    if (errors.length) throw new Error(`${errors.length} payment sync(s) failed: ${errors[0]}`);
    return { synced };
});

module.exports = { registerHandler };
