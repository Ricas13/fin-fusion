'use strict';

const { query } = require('../db');
const buildInfo = require('../build-info');
const lifecycle = require('./lifecycle');
const providerSettings = require('./provider-settings');
const providerOps = require('./provider-operations');
const providerHttp = require('./provider-http');

const HEALTHY_SYNC_MS = 6 * 60 * 60 * 1000;
const MIN_RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

let stripeClient = null;
let stripeClientKey = null;
let paypalToken = null;
let paypalTokenUntil = 0;
let paypalCredentialKey = null;

function isRecurring(row) {
    const id = String(row?.provider_subscription_id || '');
    if (row?.source === 'stripe') return /^sub_/i.test(id);
    if (row?.source === 'paypal') return /^I-/i.test(id);
    return false;
}

function providerMissing(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || '').toLowerCase();
    const detail = String(error?.message || error || '');
    return status === 404 || code === 'resource_missing' || /no such subscription|\b404\b[^\n]*\bsubscription\b|\bsubscription\b[^\n]*\b404\b/i.test(detail);
}

function stripeTerminalStatus(status) {
    return ['canceled', 'cancelled', 'incomplete_expired'].includes(String(status || '').toLowerCase());
}

function paypalTerminalStatus(status) {
    return ['CANCELLED', 'EXPIRED'].includes(String(status || '').toUpperCase());
}

function retryDelayMs(failures) {
    const count = Math.max(1, Number(failures || 1));
    return Math.min(MAX_RETRY_MS, MIN_RETRY_MS * (2 ** Math.min(5, count - 1)));
}

function stripePeriod(subscription) {
    const items = subscription?.items?.data || [];
    const ends = items.map(item => Number(item.current_period_end)).filter(Number.isFinite);
    const end = ends.length ? Math.max(...ends) : Number(subscription?.current_period_end);
    return Number.isFinite(end) ? new Date(end * 1000) : null;
}

function stripePriceId(subscription) {
    const price = subscription?.items?.data?.[0]?.price;
    return typeof price === 'string' ? price : price?.id || null;
}

async function stripeAdapter() {
    const cfg = await providerSettings.get('stripe');
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) throw new Error('Stripe is disabled or not configured.');
    if (!stripeClient || stripeClientKey !== key) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(key, {
            apiVersion: '2026-06-24.dahlia',
            appInfo: buildInfo.providerAppInfo(),
            timeout: providerHttp.timeoutMs('stripe')
        });
        stripeClientKey = key;
    }
    return {
        async fetchRemote(row) {
            const subscription = await stripeClient.subscriptions.retrieve(row.provider_subscription_id, { expand: ['items.data.price'] });
            return {
                status: subscription.status,
                periodEnd: stripePeriod(subscription),
                cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
                priceId: stripePriceId(subscription)
            };
        },
        async stopRenewal(row, { idempotencyKey = null } = {}) {
            await stripeClient.subscriptions.update(row.provider_subscription_id, { cancel_at_period_end: true }, idempotencyKey ? { idempotencyKey } : undefined);
        },
        async resumeRenewal(row, { idempotencyKey = null } = {}) {
            await stripeClient.subscriptions.update(row.provider_subscription_id, { cancel_at_period_end: false }, idempotencyKey ? { idempotencyKey } : undefined);
        },
        async terminate(row, { idempotencyKey = null } = {}) {
            try {
                let subscription = await stripeClient.subscriptions.retrieve(row.provider_subscription_id, { expand: ['items.data.price'] });
                if (stripeTerminalStatus(subscription?.status)) return { status: 'cancelled', remoteStatus: String(subscription.status || '').toLowerCase() };
                subscription = await stripeClient.subscriptions.cancel(row.provider_subscription_id, { invoice_now: false, prorate: false }, idempotencyKey ? { idempotencyKey } : undefined);
                let remoteStatus = String(subscription?.status || '').toLowerCase();
                if (!stripeTerminalStatus(remoteStatus)) {
                    subscription = await stripeClient.subscriptions.retrieve(row.provider_subscription_id, { expand: ['items.data.price'] });
                    remoteStatus = String(subscription?.status || '').toLowerCase();
                }
                if (!stripeTerminalStatus(remoteStatus)) throw new Error(`Stripe subscription ${row.provider_subscription_id} is still ${remoteStatus || 'non-terminal'} after cancellation.`);
                return { status: 'cancelled', remoteStatus };
            } catch (error) {
                if (providerMissing(error)) return { status: 'already_missing', remoteStatus: 'missing' };
                throw error;
            }
        }
    };
}

function paypalBaseUrl(cfg) { return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
function paypalHttpError(response, payload, requestId, prefix = 'PayPal HTTP') {
    const detail = payload?.message || payload?.name || payload?.error_description || 'request failed';
    const error = providerHttp.responseError('paypal', response, payload, requestId, `${prefix} ${response.status}: ${detail}`);
    error.message = `${prefix} ${response.status}: ${detail}`;
    return error;
}
async function paypalAccessToken() {
    const cfg = await providerSettings.get('paypal');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is disabled or not configured.');
    const credentialKey = `${cfg.environment || 'sandbox'}:${cfg.clientId}:${cfg.clientSecret}`;
    if (credentialKey !== paypalCredentialKey) { paypalCredentialKey = credentialKey; paypalToken = null; paypalTokenUntil = 0; }
    if (paypalToken && Date.now() < paypalTokenUntil - 60000) return { cfg, token: paypalToken };
    const { response, data: payload, requestId } = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    if (!response.ok || !payload.access_token) throw paypalHttpError(response, payload, requestId, 'PayPal OAuth failed:');
    paypalToken = payload.access_token;
    paypalTokenUntil = Date.now() + Number(payload.expires_in || 300) * 1000;
    return { cfg, token: paypalToken };
}
async function paypalApi(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
    const { cfg, token } = await paypalAccessToken();
    const result = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'PayPal-Request-Id': String(idempotencyKey).slice(0, 108) } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = result.data || {};
    if (!result.response.ok) throw paypalHttpError(result.response, payload, result.requestId);
    return payload;
}
async function paypalAdapter() {
    await paypalAccessToken();
    return {
        async fetchRemote(row) {
            const subscription = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`);
            const status = String(subscription.status || '').toUpperCase();
            const nextBilling = subscription.billing_info?.next_billing_time ? new Date(subscription.billing_info.next_billing_time) : null;
            if (status === 'CANCELLED' && new Date(row.current_period_end) > new Date()) return { status:'active',remoteStatus:'CANCELLED',periodEnd:new Date(row.current_period_end),cancelAtPeriodEnd:true };
            return { status,remoteStatus:status,periodEnd:nextBilling || (row.current_period_end ? new Date(row.current_period_end) : null),cancelAtPeriodEnd:status === 'CANCELLED' };
        },
        async stopRenewal(row, { idempotencyKey = null } = {}) {
            await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`, { method:'POST',body:{reason:'Renewal disabled by CAPTAiNFiN administrator'},idempotencyKey });
        },
        async resumeRenewal() { throw new Error('A cancelled PayPal subscription cannot be resumed automatically. The customer must start a new PayPal subscription.'); },
        async terminate(row, { idempotencyKey = null } = {}) {
            try {
                let subscription = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`);
                let remoteStatus = String(subscription?.status || '').toUpperCase();
                if (paypalTerminalStatus(remoteStatus)) return { status:'cancelled',remoteStatus };
                await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`, { method:'POST',body:{reason:'Customer account hard-deleted in CAPTAiNFiN'},idempotencyKey });
                subscription = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`);
                remoteStatus = String(subscription?.status || '').toUpperCase();
                if (!paypalTerminalStatus(remoteStatus)) throw new Error(`PayPal subscription ${row.provider_subscription_id} is still ${remoteStatus || 'non-terminal'} after cancellation.`);
                return { status:'cancelled',remoteStatus };
            } catch (error) {
                if (providerMissing(error)) return { status:'already_missing',remoteStatus:'MISSING' };
                throw error;
            }
        }
    };
}
async function defaultAdapter(provider) {
    if (provider === 'stripe') return stripeAdapter();
    if (provider === 'paypal') return paypalAdapter();
    throw new Error('Unsupported recurring payment provider.');
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
        const remoteAdapter = adapter || await defaultAdapter(row.source), remote = await remoteAdapter.fetchRemote(row);
        if (!remote || !remote.status) throw new Error('Provider returned an invalid subscription state.');
        verifyExpectedRemote(row, remote, { expectedCancelAtPeriodEnd, expectedProviderPriceId });
        await applyRemoteState(row, remote); await recordSuccess(row, remote);
        return { ok:true,subscriptionId:row.id,provider:row.source,remote };
    } catch (error) {
        const failures = await recordFailure(row, error);
        return { ok:false,subscriptionId:row.id,provider:row.source,error:error.message,failures };
    }
}
async function dueSubscriptions({ all = false, limit = 100 } = {}) {
    const result = await query(`SELECT s.id,s.source,s.provider_subscription_id,s.status,s.cancel_at_period_end,s.current_period_end FROM subscriptions s LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id WHERE s.source IN ('stripe','paypal') AND ((s.source='stripe' AND s.provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND s.provider_subscription_id LIKE 'I-%')) AND s.status IN ('active','trialing','past_due','paused') AND ($1::boolean OR ps.next_attempt_at IS NULL OR ps.next_attempt_at <= NOW()) ORDER BY COALESCE(ps.next_attempt_at,'1970-01-01'::timestamptz),s.updated_at LIMIT $2`, [Boolean(all),Math.max(1,Math.min(500,Number(limit) || 100))]);
    return result.rows;
}
async function syncDue({ all = false, limit = 100, adapters = {} } = {}) {
    const rows = await dueSubscriptions({ all, limit }), summary = { total:rows.length,succeeded:0,failed:0,results:[] };
    for (const row of rows) { const result = await syncSubscription(row.id, { adapter:adapters[row.source] || null }); summary.results.push(result); if (result.ok) summary.succeeded += 1; else summary.failed += 1; }
    return summary;
}
async function setRenewal(subscriptionId, enabled, actorUserId = null, { adapter = null } = {}) {
    const row = await subscriptionById(subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    if (!isRecurring(row)) throw new Error('This is not a recurring subscription.');
    if (!['active','trialing','past_due','paused'].includes(row.status)) throw new Error('This subscription is no longer renewable.');
    if (row.source === 'paypal' && enabled) throw new Error('A cancelled PayPal subscription cannot be resumed. The customer must subscribe again.');
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
    const desired = Boolean(request.desiredCancelAtPeriodEnd), remoteAdapter = await defaultAdapter(row.source);
    let remote = await remoteAdapter.fetchRemote(row);
    if (!remote || !remote.status || typeof remote.cancelAtPeriodEnd !== 'boolean') throw new Error('Provider returned an ambiguous renewal state.');
    await providerOps.observed(op.id, { result:{cancelAtPeriodEnd:remote.cancelAtPeriodEnd,remoteStatus:remote.remoteStatus || remote.status || null} });
    if (remote.cancelAtPeriodEnd !== desired) {
        if (['provider_applied','local_applied'].includes(op.state)) throw recoveryManual('Provider no longer reflects the already-applied renewal decision; refusing to overwrite a later remote decision.');
        if (desired) await remoteAdapter.stopRenewal(row, { idempotencyKey:op.idempotency_key }); else await remoteAdapter.resumeRenewal(row, { idempotencyKey:op.idempotency_key });
        remote = await remoteAdapter.fetchRemote(row);
        if (!remote || remote.cancelAtPeriodEnd !== desired) throw new Error('Provider renewal state remains ambiguous after idempotent recovery.');
    }
    if (op.state === 'planned') await providerOps.providerApplied(op.id, { providerReference:row.provider_subscription_id,result:{desiredCancelAtPeriodEnd:desired,recovered:true} });
    verifyExpectedRemote(row, remote, { expectedCancelAtPeriodEnd:desired });
    await applyRemoteState(row, remote); await recordSuccess(row, remote);
    if (op.state !== 'local_applied') await providerOps.localApplied(op.id, { localReference:row.id,result:{cancelAtPeriodEnd:desired,recovered:true} });
    await providerOps.reconciled(op.id, { result:{subscriptionId:row.id,recovered:true} });
    return { ok:true,id:op.id,type:op.operation_type };
}
async function dashboardData() {
    const [subscriptions, events] = await Promise.all([
        query(`SELECT s.id,s.customer_id,s.plan_id,s.status,s.source,s.starts_at,s.current_period_end,s.cancel_at_period_end,s.provider_customer_id,s.provider_subscription_id,s.created_at,s.updated_at,p.name AS plan_name,p.code AS plan_code,p.price_minor,p.currency,c.display_name,c.email,u.username AS portal_username,ps.remote_status,ps.remote_period_end,ps.remote_cancel_at_period_end,ps.last_attempt_at,ps.last_success_at,ps.last_error,ps.consecutive_failures,ps.next_attempt_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id WHERE s.source IN ('stripe','paypal') ORDER BY s.updated_at DESC LIMIT 500`),
        query(`SELECT provider,provider_event_id,event_type,processed_at,processing_error,created_at FROM payment_events WHERE provider IN ('stripe','paypal') ORDER BY created_at DESC LIMIT 50`)
    ]);
    const rows = subscriptions.rows.map(row => ({ ...row, recurring:isRecurring(row) }));
    return { subscriptions:rows,events:events.rows,stats:{recurring:rows.filter(row=>row.recurring).length,active:rows.filter(row=>row.recurring&&['active','trialing'].includes(row.status)).length,pastDue:rows.filter(row=>row.recurring&&row.status==='past_due').length,cancelling:rows.filter(row=>row.recurring&&row.cancel_at_period_end).length,syncProblems:rows.filter(row=>row.recurring&&row.last_error).length} };
}

module.exports = { HEALTHY_SYNC_MS,MIN_RETRY_MS,MAX_RETRY_MS,isRecurring,providerMissing,stripeTerminalStatus,paypalTerminalStatus,retryDelayMs,terminateRecurringForDeletion,syncSubscription,syncDue,setRenewal,recoverProviderOperation,dashboardData,subscriptionById,stripePeriod,stripePriceId,applyRemoteState,verifyExpectedRemote };
