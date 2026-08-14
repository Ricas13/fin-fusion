'use strict';

const { query } = require('../db');
const lifecycle = require('./lifecycle');
const providerSettings = require('./provider-settings');
const provisioning = require('../jellyfin/resilient-provisioning');

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

async function stripeAdapter() {
    const cfg = await providerSettings.get('stripe');
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) throw new Error('Stripe is disabled or not configured.');
    if (!stripeClient || stripeClientKey !== key) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(key, {
            apiVersion: '2026-06-24.dahlia',
            appInfo: { name: 'CAPTaINFiN', version: '1.0.0' }
        });
        stripeClientKey = key;
    }
    return {
        async fetchRemote(row) {
            const subscription = await stripeClient.subscriptions.retrieve(row.provider_subscription_id, { expand: ['items.data.price'] });
            return {
                status: subscription.status,
                periodEnd: stripePeriod(subscription),
                cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
            };
        },
        async stopRenewal(row) {
            await stripeClient.subscriptions.update(row.provider_subscription_id, { cancel_at_period_end: true });
        },
        async resumeRenewal(row) {
            await stripeClient.subscriptions.update(row.provider_subscription_id, { cancel_at_period_end: false });
        }
    };
}

function paypalBaseUrl(cfg) {
    return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalAccessToken() {
    const cfg = await providerSettings.get('paypal');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is disabled or not configured.');
    const credentialKey = `${cfg.environment || 'sandbox'}:${cfg.clientId}:${cfg.clientSecret}`;
    if (credentialKey !== paypalCredentialKey) {
        paypalCredentialKey = credentialKey;
        paypalToken = null;
        paypalTokenUntil = 0;
    }
    if (paypalToken && Date.now() < paypalTokenUntil - 60000) return { cfg, token: paypalToken };
    const response = await fetch(`${paypalBaseUrl(cfg)}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error(`PayPal OAuth failed: ${payload.error_description || response.status}`);
    paypalToken = payload.access_token;
    paypalTokenUntil = Date.now() + Number(payload.expires_in || 300) * 1000;
    return { cfg, token: paypalToken };
}

async function paypalApi(path, { method = 'GET', body = null } = {}) {
    const { cfg, token } = await paypalAccessToken();
    const response = await fetch(`${paypalBaseUrl(cfg)}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let payload = {};
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    }
    if (!response.ok) throw new Error(`PayPal HTTP ${response.status}: ${payload.message || payload.name || 'request failed'}`);
    return payload;
}

async function paypalAdapter() {
    await paypalAccessToken();
    return {
        async fetchRemote(row) {
            const subscription = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`);
            const status = String(subscription.status || '').toUpperCase();
            const nextBilling = subscription.billing_info?.next_billing_time ? new Date(subscription.billing_info.next_billing_time) : null;
            if (status === 'CANCELLED' && new Date(row.current_period_end) > new Date()) {
                return {
                    status: 'active',
                    remoteStatus: 'CANCELLED',
                    periodEnd: new Date(row.current_period_end),
                    cancelAtPeriodEnd: true
                };
            }
            return {
                status,
                remoteStatus: status,
                periodEnd: nextBilling || (row.current_period_end ? new Date(row.current_period_end) : null),
                cancelAtPeriodEnd: status === 'CANCELLED'
            };
        },
        async stopRenewal(row) {
            await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`, {
                method: 'POST',
                body: { reason: 'Renewal disabled by CAPTaINFiN administrator' }
            });
        },
        async resumeRenewal() {
            throw new Error('A cancelled PayPal subscription cannot be resumed automatically. The customer must start a new PayPal subscription.');
        }
    };
}

async function defaultAdapter(provider) {
    if (provider === 'stripe') return stripeAdapter();
    if (provider === 'paypal') return paypalAdapter();
    throw new Error('Unsupported recurring payment provider.');
}

async function subscriptionById(id) {
    const result = await query(`
        SELECT s.*,p.name AS plan_name,p.code AS plan_code,p.currency,p.price_minor,
               c.display_name,c.email,u.username AS portal_username
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE s.id=$1
    `, [id]);
    return result.rows[0] || null;
}

async function recordSuccess(row, remote) {
    const now = new Date();
    const next = new Date(now.getTime() + HEALTHY_SYNC_MS);
    await query(`
        INSERT INTO subscription_provider_sync(
            subscription_id,provider,remote_status,remote_period_end,remote_cancel_at_period_end,
            last_attempt_at,last_success_at,last_error,consecutive_failures,next_attempt_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$6,NULL,0,$7,NOW())
        ON CONFLICT(subscription_id) DO UPDATE SET
            provider=EXCLUDED.provider,
            remote_status=EXCLUDED.remote_status,
            remote_period_end=EXCLUDED.remote_period_end,
            remote_cancel_at_period_end=EXCLUDED.remote_cancel_at_period_end,
            last_attempt_at=EXCLUDED.last_attempt_at,
            last_success_at=EXCLUDED.last_success_at,
            last_error=NULL,
            consecutive_failures=0,
            next_attempt_at=EXCLUDED.next_attempt_at,
            updated_at=NOW()
    `, [row.id, row.source, remote.remoteStatus || remote.status || null, remote.periodEnd || null, remote.cancelAtPeriodEnd ?? null, now, next]);
}

async function recordFailure(row, error) {
    const prior = await query(`SELECT consecutive_failures FROM subscription_provider_sync WHERE subscription_id=$1`, [row.id]);
    const failures = Number(prior.rows[0]?.consecutive_failures || 0) + 1;
    const now = new Date();
    const next = new Date(now.getTime() + retryDelayMs(failures));
    await query(`
        INSERT INTO subscription_provider_sync(
            subscription_id,provider,last_attempt_at,last_error,consecutive_failures,next_attempt_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT(subscription_id) DO UPDATE SET
            provider=EXCLUDED.provider,
            last_attempt_at=EXCLUDED.last_attempt_at,
            last_error=EXCLUDED.last_error,
            consecutive_failures=EXCLUDED.consecutive_failures,
            next_attempt_at=EXCLUDED.next_attempt_at,
            updated_at=NOW()
    `, [row.id, row.source, now, String(error?.message || error).slice(0, 1500), failures, next]);
    return failures;
}

async function applyRemoteState(row, remote) {
    const status = lifecycle.mapProviderStatus(row.source, remote.status);
    const updated = await query(`
        UPDATE subscriptions
        SET status=$1,
            current_period_end=COALESCE($2,current_period_end),
            cancel_at_period_end=COALESCE($3,cancel_at_period_end),
            updated_at=NOW()
        WHERE id=$4
        RETURNING customer_id,status,current_period_end,cancel_at_period_end
    `, [status, remote.periodEnd || null, remote.cancelAtPeriodEnd ?? null, row.id]);
    if (!updated.rowCount) throw new Error('Subscription disappeared during provider sync.');

    // Provider verification is authoritative independently of Jellyfin health.
    // Provisioning has its own retry/control state, so an offline media server
    // must not make a successful payment-provider verification look failed.
    try {
        await provisioning.reconcileCustomer(updated.rows[0].customer_id);
    } catch (error) {
        console.warn(`Billing sync provisioning follow-up blocked for ${updated.rows[0].customer_id}:`, error.message);
    }
    return updated.rows[0];
}

async function syncSubscription(subscriptionId, { adapter = null } = {}) {
    const row = await subscriptionById(subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    if (!isRecurring(row)) throw new Error('This subscription is not a recurring Stripe/PayPal subscription.');
    try {
        const remoteAdapter = adapter || await defaultAdapter(row.source);
        const remote = await remoteAdapter.fetchRemote(row);
        if (!remote || !remote.status) throw new Error('Provider returned an invalid subscription state.');
        await applyRemoteState(row, remote);
        await recordSuccess(row, remote);
        return { ok: true, subscriptionId: row.id, provider: row.source, remote };
    } catch (error) {
        const failures = await recordFailure(row, error);
        return { ok: false, subscriptionId: row.id, provider: row.source, error: error.message, failures };
    }
}

async function dueSubscriptions({ all = false, limit = 100 } = {}) {
    const result = await query(`
        SELECT s.id,s.source,s.provider_subscription_id,s.status,s.cancel_at_period_end,s.current_period_end
        FROM subscriptions s
        LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id
        WHERE s.source IN ('stripe','paypal')
          AND (
              (s.source='stripe' AND s.provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\')
              OR (s.source='paypal' AND s.provider_subscription_id LIKE 'I-%')
          )
          AND s.status IN ('active','trialing','past_due','paused')
          AND ($1::boolean OR ps.next_attempt_at IS NULL OR ps.next_attempt_at <= NOW())
        ORDER BY COALESCE(ps.next_attempt_at,'1970-01-01'::timestamptz),s.updated_at
        LIMIT $2
    `, [Boolean(all), Math.max(1, Math.min(500, Number(limit) || 100))]);
    return result.rows;
}

async function syncDue({ all = false, limit = 100, adapters = {} } = {}) {
    const rows = await dueSubscriptions({ all, limit });
    const summary = { total: rows.length, succeeded: 0, failed: 0, results: [] };
    for (const row of rows) {
        const result = await syncSubscription(row.id, { adapter: adapters[row.source] || null });
        summary.results.push(result);
        if (result.ok) summary.succeeded += 1;
        else summary.failed += 1;
    }
    return summary;
}

async function setRenewal(subscriptionId, enabled, actorUserId = null, { adapter = null } = {}) {
    const row = await subscriptionById(subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    if (!isRecurring(row)) throw new Error('This is not a recurring subscription.');
    if (!['active','trialing','past_due','paused'].includes(row.status)) throw new Error('This subscription is no longer renewable.');
    if (row.source === 'paypal' && enabled) throw new Error('A cancelled PayPal subscription cannot be resumed. The customer must subscribe again.');

    const remoteAdapter = adapter || await defaultAdapter(row.source);
    if (enabled) await remoteAdapter.resumeRenewal(row);
    else await remoteAdapter.stopRenewal(row);

    if (row.source === 'paypal' && !enabled) {
        await query(`UPDATE subscriptions SET cancel_at_period_end=TRUE,updated_at=NOW() WHERE id=$1`, [row.id]);
    }
    const synced = await syncSubscription(row.id, { adapter: remoteAdapter });
    if (!synced.ok) throw new Error(`Provider accepted the renewal change, but verification failed: ${synced.error}`);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'subscription',$3,$4::jsonb)
    `, [actorUserId, enabled ? 'billing.renewal.resume' : 'billing.renewal.stop', row.id, JSON.stringify({ provider: row.source, providerSubscriptionId: row.provider_subscription_id })]);
    return synced;
}

async function dashboardData() {
    const [subscriptions, events] = await Promise.all([
        query(`
            SELECT s.id,s.customer_id,s.plan_id,s.status,s.source,s.starts_at,s.current_period_end,s.cancel_at_period_end,
                   s.provider_customer_id,s.provider_subscription_id,s.created_at,s.updated_at,
                   p.name AS plan_name,p.code AS plan_code,p.price_minor,p.currency,
                   c.display_name,c.email,u.username AS portal_username,
                   ps.remote_status,ps.remote_period_end,ps.remote_cancel_at_period_end,ps.last_attempt_at,
                   ps.last_success_at,ps.last_error,ps.consecutive_failures,ps.next_attempt_at
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            JOIN customers c ON c.id=s.customer_id
            LEFT JOIN app_users u ON u.id=c.user_id
            LEFT JOIN subscription_provider_sync ps ON ps.subscription_id=s.id
            WHERE s.source IN ('stripe','paypal')
            ORDER BY s.updated_at DESC
            LIMIT 500
        `),
        query(`
            SELECT provider,provider_event_id,event_type,processed_at,processing_error,created_at
            FROM payment_events
            WHERE provider IN ('stripe','paypal')
            ORDER BY created_at DESC LIMIT 50
        `)
    ]);
    const rows = subscriptions.rows.map(row => ({ ...row, recurring: isRecurring(row) }));
    return {
        subscriptions: rows,
        events: events.rows,
        stats: {
            recurring: rows.filter(row => row.recurring).length,
            active: rows.filter(row => row.recurring && ['active','trialing'].includes(row.status)).length,
            pastDue: rows.filter(row => row.recurring && row.status === 'past_due').length,
            cancelling: rows.filter(row => row.recurring && row.cancel_at_period_end).length,
            syncProblems: rows.filter(row => row.recurring && row.last_error).length
        }
    };
}

module.exports = {
    HEALTHY_SYNC_MS,
    MIN_RETRY_MS,
    MAX_RETRY_MS,
    isRecurring,
    retryDelayMs,
    syncSubscription,
    syncDue,
    setRenewal,
    dashboardData,
    subscriptionById,
    stripePeriod,
    applyRemoteState
};
