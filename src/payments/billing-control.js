'use strict';

const { query } = require('../db');
const lifecycle = require('./lifecycle');
const billingMode = require('./subscription-billing-mode');
const providerOps = require('./provider-operations');
const providerContract = require('./provider-contract');
const subscriptionState = require('../entitlements/subscription-state');

const HEALTHY_SYNC_MS = 6 * 60 * 60 * 1000;
const MIN_RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

function isRecurring(row) {
    return billingMode.isRecurring(row);
}

function validRecurringProviderReference(row) {
    return billingMode.validRecurringProviderReference(row);
}

function providerMissing(error) {
    return providerContract.providerMissing(error);
}

function paypalTerminalStatus(status) {
    return providerContract.state('paypal',status).terminal;
}

function retryDelayMs(failures) {
    const count = Math.max(1, Number(failures || 1));
    return Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.min(5, count - 1)));
}

function stripePeriod(subscription) {
    return providerContract.stripePeriod(subscription);
}

function stripePriceId(subscription) {
    return providerContract.stripePriceId(subscription);
}

async function defaultAdapter(provider) {
    return providerContract.recurring(provider);
}

async function terminateRecurringForDeletion(row, { adapter = null, idempotencyKey = null } = {}) {
    if (!isRecurring(row)) throw new Error('This is not a recurring Stripe/PayPal subscription.');
    const remoteAdapter = adapter || await defaultAdapter(row.source);
    if (typeof remoteAdapter.terminate !== 'function') throw new Error(`Recurring ${row.source} adapter cannot prove immediate cancellation.`);
    const result = await remoteAdapter.terminate(row, { idempotencyKey });
    if (!result || !['cancelled', 'already_missing'].includes(result.status)) throw new Error(`Recurring ${row.source} subscription cancellation could not be verified.`);
    return { ...result, provider:row.source, providerSubscriptionId:row.provider_subscription_id, subscriptionId:row.id || null };
}

async function subscriptionById(id) {
    const result = await query(`SELECT s.*,p.name AS plan_name,p.code AS plan_code,p.currency,p.price_minor,c.display_name,c.email,u.username AS portal_username FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE s.id=$1`, [id]);
    return result.rows[0] || null;
}
async function recordSuccess(row, remote) {
    const now = new Date(), next = new Date(now.getTime() + HEALTHY_SYNC_MS);
    await query(`INSERT INTO subscription_provider_sync(subscription_id,provider,remote_status,remote_period_end,remote_cancel_at_period_end,last_attempt_at,last_success_at,last_error,consecutive_failures,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,NULL,0,$7,NOW()) ON CONFLICT(subscription_id) DO UPDATE SET provider=EXCLUDED.provider,remote_status=EXCLUDED.remote_status,remote_period_end=EXCLUDED.remote_period_end,remote_cancel_at_period_end=EXCLUDED.remote_cancel_at_period_end,last_attempt_at=EXCLUDED.last_attempt_at,last_success_at=EXCLUDED.last_success_at,last_error=NULL,consecutive_failures=0,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=NOW()`, [row.id,row.source,remote.remoteStatus || remote.status || null,remote.periodEnd || null,remote.cancelAtPeriodEnd ?? null,now,next]);
}
async function recordFailure(row, error) {
    const prior = await query(`SELECT consecutive_failures FROM subscription_provider_sync WHERE subscription_id=$1`, [row.id]);
    const failures = Number(prior.rows[0]?.consecutive_failures || 0) + 1, now = new Date(), next = new Date(now.getTime() + retryDelayMs(failures));
    await query(`INSERT INTO subscription_provider_sync(subscription_id,provider,last_attempt_at,last_error,consecutive_failures,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(subscription_id) DO UPDATE SET provider=EXCLUDED.provider,last_attempt_at=EXCLUDED.last_attempt_at,last_error=EXCLUDED.last_error,consecutive_failures=EXCLUDED.consecutive_failures,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=NOW()`, [row.id,row.source,now,String(error?.message || error).slice(0,1500),failures,next]);
    return failures;
}
function remoteStateForPolicy(row, remote, { now = new Date() } = {}) {
    const result = { ...(remote || {}) };
    const localEnd = row?.current_period_end ? new Date(row.current_period_end) : null;
    if (!result.periodEnd && localEnd && Number.isFinite(localEnd.getTime())) result.periodEnd = localEnd;

    if (String(row?.source || '').toLowerCase() === 'paypal') {
        const providerStatus = providerContract.normalizeState('paypal', result.remoteStatus || result.status);
        if (['CANCELLED','CANCELED'].includes(providerStatus)
            && localEnd && Number.isFinite(localEnd.getTime())
            && localEnd.getTime() > new Date(now).getTime()) {
            // PayPal cancellation stops renewal immediately but does not erase
            // access already paid through the current local period. This is a
            // CAPTAiNFiN commercial-policy decision, not provider transport.
            result.status = 'active';
            result.periodEnd = localEnd;
            result.cancelAtPeriodEnd = true;
        }
    }
    return result;
}

async function applyRemoteState(row, remote) {
    const updated = await lifecycle.updateProviderSubscription({ provider:row.source,providerSubscriptionId:row.provider_subscription_id,providerStatus:remote.status,periodEnd:remote.periodEnd || null,cancelAtPeriodEnd:remote.cancelAtPeriodEnd ?? null });
    if (!updated || String(updated.id) !== String(row.id)) throw new Error('Subscription disappeared during provider sync.');
    return updated;
}
function verifyExpectedRemote(row, remote, { expectedCancelAtPeriodEnd = null, expectedProviderPriceId = null } = {}) {
    if (expectedCancelAtPeriodEnd !== null) {
        if (typeof remote?.cancelAtPeriodEnd !== 'boolean') throw new Error('Provider did not return a verifiable renewal state.');
        if (remote.cancelAtPeriodEnd !== Boolean(expectedCancelAtPeriodEnd)) throw new Error(`Provider renewal verification mismatch: expected cancel_at_period_end=${Boolean(expectedCancelAtPeriodEnd)} but observed ${remote.cancelAtPeriodEnd}.`);
    }
    if (expectedProviderPriceId !== null) {
        if (row.source !== 'stripe') throw new Error('Provider price verification is only supported for Stripe recurring subscriptions.');
        const observed = String(remote?.priceId || '');
        if (!observed || observed !== String(expectedProviderPriceId)) throw new Error(`Stripe price verification mismatch: expected ${String(expectedProviderPriceId)} but observed ${observed || 'missing'}.`);
    }
}
async function syncSubscription(subscriptionId, { adapter = null, expectedCancelAtPeriodEnd = null, expectedProviderPriceId = null } = {}) {
    const row = await subscriptionById(subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    if (!isRecurring(row)) throw new Error('This subscription is not a recurring Stripe/PayPal subscription.');
    try {
        const remoteAdapter = adapter || await defaultAdapter(row.source);
        const providerRemote = await remoteAdapter.fetchRemote(row);
        if (!providerRemote || !providerRemote.status) throw new Error('Provider returned an invalid subscription state.');
        const remote = remoteStateForPolicy(row, providerRemote);
        verifyExpectedRemote(row, remote, { expectedCancelAtPeriodEnd, expectedProviderPriceId });
        await applyRemoteState(row, remote); await recordSuccess(row, remote);
        return { ok:true,subscriptionId:row.id,provider:row.source,remote };
    } catch (error) {
        const failures = await recordFailure(row, error);
        return { ok:false,subscriptionId:row.id,provider:row.source,error:error.message,failures };
    }
}
async function dueSubscriptions({ all = false, limit = 100 } = {}) {
    const result = await query(`SELECT s.id,s.source,s.billing_mode,s.provider_subscription_id,s.status,s.cancel_at_period_end,s.current_period_end FROM subscriptions s LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id WHERE s.source IN ('stripe','paypal') AND s.billing_mode='subscription' AND s.status IN ('active','trialing','past_due','paused') AND ($1::boolean OR ps.next_attempt_at IS NULL OR ps.next_attempt_at <= NOW()) ORDER BY COALESCE(ps.next_attempt_at,'1970-01-01'::timestamptz),s.updated_at LIMIT $2`, [Boolean(all),Math.max(1,Math.min(500,Number(limit) || 100))]);
    return result.rows;
}
async function syncDue({ all = false, limit = 100, adapters = {} } = {}) {
    const rows = await dueSubscriptions({ all, limit }), summary = { total:rows.length,succeeded:0,failed:0,results:[] };
    for (const row of rows) { const result = await syncSubscription(row.id, { adapter:adapters[row.source] || null }); summary.results.push(result); if (result.ok) summary.succeeded += 1; else summary.failed += 1; }
    return summary;
}
async function setCustomerRenewal(customerId, enabled, actorUserId = null, options = {}) {
    const current = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
    if (!current) throw new Error('This customer has no subscription to change renewal for.');
    return setRenewal(current.subscription_id || current.id, enabled, actorUserId, options);
}

async function setRenewal(subscriptionId, enabled, actorUserId = null, { adapter = null } = {}) {
    const row = await subscriptionById(subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    if (!isRecurring(row)) throw new Error('This is not a recurring subscription.');
    if (!['active','trialing','past_due','paused'].includes(row.status)) throw new Error('This subscription is no longer renewable.');
    if (row.source === 'paypal' && enabled) throw new Error('A cancelled PayPal subscription cannot be resumed. The customer must subscribe again.');
    if (!enabled) {
        const pendingChange = await query(`
            SELECT id
            FROM customer_plan_changes
            WHERE current_subscription_id=$1
              AND state IN('pending','awaiting_checkout')
            LIMIT 1
        `, [row.id]);
        if (pendingChange.rowCount) throw new Error('Cancel the scheduled plan change before stopping automatic renewal.');
    }
    const op = await providerOps.begin({ provider:row.source,scope:'customer',ownerId:row.customer_id,operationType:enabled?'renewal_resume':'renewal_stop',localReference:row.id,request:{subscriptionId:row.id,providerSubscriptionId:row.provider_subscription_id,desiredCancelAtPeriodEnd:!enabled,priorCancelAtPeriodEnd:Boolean(row.cancel_at_period_end)} });
    try {
        const remoteAdapter = adapter || await defaultAdapter(row.source);
        if (enabled) await remoteAdapter.resumeRenewal(row, { idempotencyKey:op.idempotency_key }); else await remoteAdapter.stopRenewal(row, { idempotencyKey:op.idempotency_key });
        await providerOps.providerApplied(op.id, { providerReference:row.provider_subscription_id,result:{desiredCancelAtPeriodEnd:!enabled} });
        const synced = await syncSubscription(row.id, { adapter:remoteAdapter, expectedCancelAtPeriodEnd:!enabled });
        if (!synced.ok) throw new Error(`Provider accepted the renewal change, but verification failed: ${synced.error}`);
        await providerOps.localApplied(op.id, { localReference:row.id,result:{cancelAtPeriodEnd:synced.remote?.cancelAtPeriodEnd ?? null} });
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'subscription',$3,$4::jsonb)`, [actorUserId,enabled?'billing.renewal.resume':'billing.renewal.stop',row.id,JSON.stringify({provider:row.source,providerSubscriptionId:row.provider_subscription_id,providerOperationId:op.id})]);
        await providerOps.reconciled(op.id, { result:{subscriptionId:row.id,recovered:false} });
        return synced;
    } catch (error) { await providerOps.recordError(op.id,error).catch(() => {}); throw error; }
}
function recoveryManual(message) { const error = new Error(message); error.providerOperationManual = true; return error; }
function recoverySuperseded(message) { const error = new Error(message); error.providerOperationSuperseded = true; return error; }
async function recoverProviderOperation(op) {
    if (!['renewal_stop','renewal_resume'].includes(op.operation_type)) throw recoveryManual(`Unsupported renewal recovery type ${op.operation_type}.`);
    const newer = await providerOps.newerOperation(op, { operationTypes:['renewal_stop','renewal_resume'] });
    if (newer) throw recoverySuperseded(`Superseded by newer ${newer.operation_type} operation ${newer.id}.`);
    const request = op.request_snapshot || {}, subscriptionId = request.subscriptionId || op.local_reference, row = await subscriptionById(subscriptionId);
    if (!row || String(row.customer_id) !== String(op.owner_id)) throw recoveryManual('Renewal subscription no longer exists for this customer.');
    if (!isRecurring(row)) throw recoveryManual('Renewal operation no longer points to a recurring provider subscription.');
    const desired = Boolean(request.desiredCancelAtPeriodEnd), remoteAdapter = await defaultAdapter(row.source);
    let remote = remoteStateForPolicy(row, await remoteAdapter.fetchRemote(row));
    if (!remote || !remote.status || typeof remote.cancelAtPeriodEnd !== 'boolean') throw new Error('Provider returned an ambiguous renewal state.');
    await providerOps.observed(op.id, { result:{cancelAtPeriodEnd:remote.cancelAtPeriodEnd,remoteStatus:remote.remoteStatus || remote.status || null} });
    if (remote.cancelAtPeriodEnd !== desired) {
        if (['provider_applied','local_applied'].includes(op.state)) throw recoveryManual('Provider no longer reflects the already-applied renewal decision; refusing to overwrite a later remote decision.');
        if (desired) await remoteAdapter.stopRenewal(row, { idempotencyKey:op.idempotency_key }); else await remoteAdapter.resumeRenewal(row, { idempotencyKey:op.idempotency_key });
        remote = remoteStateForPolicy(row, await remoteAdapter.fetchRemote(row));
        if (!remote || remote.cancelAtPeriodEnd !== desired) throw new Error('Provider renewal state remains ambiguous after idempotent recovery.');
    }
    if (op.state === 'planned') await providerOps.providerApplied(op.id, { providerReference:row.provider_subscription_id,result:{desiredCancelAtPeriodEnd:desired,recovered:true} });
    verifyExpectedRemote(row, remote, { expectedCancelAtPeriodEnd:desired });
    await applyRemoteState(row, remote); await recordSuccess(row, remote);
    if (op.state !== 'local_applied') await providerOps.localApplied(op.id, { localReference:row.id,result:{cancelAtPeriodEnd:desired,recovered:true} });
    await providerOps.reconciled(op.id, { result:{subscriptionId:row.id,recovered:true} });
    return { ok:true,id:op.id,type:op.operation_type };
}
async function recurringProviderCounts() {
    const result = await query(`
        SELECT
          COUNT(*) FILTER(WHERE source='stripe')::int AS stripe,
          COUNT(*) FILTER(WHERE source='paypal')::int AS paypal,
          COUNT(*) FILTER(
            WHERE (source='stripe' AND (provider_subscription_id IS DISTINCT FROM BTRIM(provider_subscription_id) OR BTRIM(COALESCE(provider_subscription_id,'')) !~* '^sub_'))
               OR (source='paypal' AND (provider_subscription_id IS DISTINCT FROM BTRIM(provider_subscription_id) OR BTRIM(COALESCE(provider_subscription_id,'')) !~* '^I-'))
          )::int AS invalid
        FROM subscriptions
        WHERE source IN ('stripe','paypal')
          AND billing_mode='subscription'
          AND status IN ('active','trialing','past_due','paused')
    `);
    const row = result.rows[0] || {};
    return {
        stripe: Number(row.stripe || 0),
        paypal: Number(row.paypal || 0),
        invalid: Number(row.invalid || 0)
    };
}

async function dashboardData() {
    const [subscriptions, events] = await Promise.all([
        query(`SELECT s.id,s.customer_id,s.plan_id,s.status,s.source,s.billing_mode,s.starts_at,s.current_period_end,s.cancel_at_period_end,s.provider_customer_id,s.provider_subscription_id,s.created_at,s.updated_at,p.name AS plan_name,p.code AS plan_code,p.price_minor,p.currency,c.display_name,c.email,u.username AS portal_username,ps.remote_status,ps.remote_period_end,ps.remote_cancel_at_period_end,ps.last_attempt_at,ps.last_success_at,ps.last_error,ps.consecutive_failures,ps.next_attempt_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id WHERE s.source IN ('stripe','paypal') ORDER BY CASE WHEN s.billing_mode='subscription' AND s.status IN ('active','trialing','past_due','paused') AND (NULLIF(BTRIM(ps.last_error),'') IS NOT NULL OR (s.status='past_due' AND COALESCE(s.cancel_at_period_end,FALSE)=FALSE) OR (s.source='stripe' AND (s.provider_subscription_id IS DISTINCT FROM BTRIM(s.provider_subscription_id) OR BTRIM(COALESCE(s.provider_subscription_id,'')) !~* '^sub_')) OR (s.source='paypal' AND (s.provider_subscription_id IS DISTINCT FROM BTRIM(s.provider_subscription_id) OR BTRIM(COALESCE(s.provider_subscription_id,'')) !~* '^I-'))) THEN 0 ELSE 1 END,s.updated_at DESC LIMIT 500`),
        query(`SELECT provider,provider_event_id,event_type,processed_at,processing_error,created_at FROM payment_events WHERE provider IN ('stripe','paypal') ORDER BY CASE WHEN processed_at IS NULL AND NULLIF(BTRIM(processing_error),'') IS NOT NULL THEN 0 ELSE 1 END,created_at DESC LIMIT 50`)
    ]);
    const rows = subscriptions.rows.map(row => ({ ...row, recurring:isRecurring(row) }));
    return { subscriptions:rows,events:events.rows,stats:{recurring:rows.filter(row=>row.recurring).length,active:rows.filter(row=>row.recurring&&['active','trialing'].includes(row.status)).length,pastDue:rows.filter(row=>row.recurring&&row.status==='past_due').length,cancelling:rows.filter(row=>row.recurring&&row.cancel_at_period_end).length,syncProblems:rows.filter(row=>row.recurring&&row.last_error).length} };
}

module.exports = { HEALTHY_SYNC_MS,MIN_RETRY_MS,MAX_RETRY_MS,isRecurring,validRecurringProviderReference,providerMissing,paypalTerminalStatus,retryDelayMs,terminateRecurringForDeletion,syncSubscription,syncDue,setRenewal,setCustomerRenewal,recoverProviderOperation,dashboardData,recurringProviderCounts,subscriptionById,stripePeriod,stripePriceId,remoteStateForPolicy,applyRemoteState,verifyExpectedRemote };