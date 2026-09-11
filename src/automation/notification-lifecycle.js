'use strict';

const { query } = require('../db');
const notificationDispatch = require('../integrations/notification-dispatch');

const STATE_KEY = 'notification_lifecycle_cursor_v1';
const INITIAL_LOOKBACK_MS = 15 * 60 * 1000;
const MAX_CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_LIMIT = 50;

function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
}

function dateKey(value) {
    const date = validDate(value);
    return date ? date.toISOString() : 'unknown';
}

function clean(value, max = 800) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(minor, currency) {
    const amount = Number(minor);
    const code = String(currency || '').toUpperCase();
    if (!Number.isFinite(amount) || !code) return '';
    return `${code} ${(amount / 100).toFixed(2)}`;
}

async function loadState(now = new Date()) {
    const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [STATE_KEY]);
    const value = result.rows[0]?.setting_value || {};
    const stored = validDate(value.cursor);
    const oldest = new Date(now.getTime() - MAX_CATCHUP_MS);
    const fallback = new Date(now.getTime() - INITIAL_LOOKBACK_MS);
    const cursor = stored && stored <= now ? (stored < oldest ? oldest : stored) : fallback;
    const servers = value.servers && typeof value.servers === 'object' && !Array.isArray(value.servers) ? value.servers : {};
    return { cursor, servers };
}

async function saveState(cursor, servers) {
    const value = { cursor: cursor.toISOString(), servers };
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES($1,$2::jsonb)
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
    `, [STATE_KEY, JSON.stringify(value)]);
}

function retryDelaySeconds(attempts) {
    const attempt = Math.max(1, Number(attempts) || 1);
    return Math.min(6 * 60 * 60, 60 * Math.pow(3, Math.min(5, attempt - 1)));
}

function retryFailureMessage(value) {
    if (Array.isArray(value)) return clean(value.join('; '), 1500) || 'Lifecycle notification delivery failed.';
    return clean(value?.message || value || 'Lifecycle notification delivery failed.', 1500);
}

function retryKey(input) {
    const key = clean(input?.dedupeKey, 500);
    if (!key) throw new Error('Lifecycle notifications require a stable dedupe key for durable retry.');
    return key;
}

async function queueRetry(input, failure) {
    const key = retryKey(input);
    await query(`
        INSERT INTO notification_lifecycle_retries(
            dedupe_key,event_type,payload,attempts,next_attempt_at,last_error,created_at,updated_at
        ) VALUES($1,$2,$3::jsonb,0,NOW(),$4,NOW(),NOW())
        ON CONFLICT(dedupe_key) DO UPDATE
        SET event_type=EXCLUDED.event_type,
            payload=EXCLUDED.payload,
            last_error=EXCLUDED.last_error,
            next_attempt_at=LEAST(notification_lifecycle_retries.next_attempt_at,NOW()),
            updated_at=NOW()
    `, [key, clean(input.eventType, 160) || 'unknown', JSON.stringify(input), retryFailureMessage(failure)]);
    return key;
}

async function clearRetry(dedupeKey) {
    const key = clean(dedupeKey, 500);
    if (!key) return false;
    const result = await query('DELETE FROM notification_lifecycle_retries WHERE dedupe_key=$1', [key]);
    return result.rowCount > 0;
}

async function dueRetries(limit = DEFAULT_RETRY_LIMIT) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || DEFAULT_RETRY_LIMIT));
    const result = await query(`
        SELECT dedupe_key,event_type,payload,attempts,next_attempt_at,last_error,created_at,updated_at
        FROM notification_lifecycle_retries
        WHERE next_attempt_at<=NOW()
        ORDER BY next_attempt_at,created_at,dedupe_key
        LIMIT $1
    `, [bounded]);
    return result.rows;
}

async function markRetryFailure(row, failure) {
    const attempts = Math.max(0, Number(row?.attempts || 0)) + 1;
    const delay = retryDelaySeconds(attempts);
    await query(`
        UPDATE notification_lifecycle_retries
        SET attempts=$2,last_attempt_at=NOW(),last_error=$3,
            next_attempt_at=NOW()+($4::int*INTERVAL '1 second'),updated_at=NOW()
        WHERE dedupe_key=$1
    `, [row.dedupe_key, attempts, retryFailureMessage(failure), delay]);
    return delay;
}

async function retryPendingCount() {
    const result = await query('SELECT COUNT(*)::int AS count FROM notification_lifecycle_retries');
    return Number(result.rows[0]?.count || 0);
}

function deliveryQueued(delivery) {
    return Boolean(delivery && (delivery.email || delivery.telegram || delivery.discord || delivery.whatsapp));
}

async function emit(summary, input) {
    summary.processed += 1;
    try {
        const delivery = await notificationDispatch.dispatch(input);
        if (deliveryQueued(delivery)) summary.queued += 1;
        if (Array.isArray(delivery?.errors) && delivery.errors.length) {
            try {
                await queueRetry(input, delivery.errors);
            } catch (retryError) {
                throw new Error(`Lifecycle notification delivery failed and durable retry could not be recorded: ${retryError.message}`);
            }
            summary.failed += 1;
            summary.retryQueued = Number(summary.retryQueued || 0) + 1;
            console.warn('Lifecycle notification had delivery errors; durable retry queued:', { eventType: input.eventType, errors: delivery.errors.slice(0, 4) });
            return delivery;
        }
        await clearRetry(input.dedupeKey);
        return delivery;
    } catch (error) {
        if (String(error?.message || '').includes('durable retry could not be recorded')) throw error;
        try {
            await queueRetry(input, error);
        } catch (retryError) {
            throw new Error(`Lifecycle notification dispatch failed and durable retry could not be recorded: ${retryError.message}`);
        }
        summary.failed += 1;
        summary.retryQueued = Number(summary.retryQueued || 0) + 1;
        console.warn('Lifecycle notification dispatch failed; durable retry queued:', { eventType: input.eventType, error: clean(error?.message || error, 500) });
        return null;
    }
}

async function processRetries(summary, { limit = DEFAULT_RETRY_LIMIT } = {}) {
    const rows = await dueRetries(limit);
    summary.retryAttempted = rows.length;
    summary.retryResolved = 0;
    summary.retryFailed = 0;
    for (const row of rows) {
        summary.processed += 1;
        const input = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : null;
        if (!input || retryKey(input) !== row.dedupe_key) {
            const error = new Error('Stored lifecycle retry payload is invalid or its dedupe key changed.');
            await markRetryFailure(row, error);
            summary.failed += 1;
            summary.retryFailed += 1;
            continue;
        }
        try {
            const delivery = await notificationDispatch.dispatch(input);
            if (deliveryQueued(delivery)) summary.queued += 1;
            if (Array.isArray(delivery?.errors) && delivery.errors.length) {
                await markRetryFailure(row, delivery.errors);
                summary.failed += 1;
                summary.retryFailed += 1;
                continue;
            }
            await clearRetry(row.dedupe_key);
            summary.retryResolved += 1;
        } catch (error) {
            await markRetryFailure(row, error);
            summary.failed += 1;
            summary.retryFailed += 1;
        }
    }
    summary.retryPending = await retryPendingCount();
    return rows.length;
}

async function subscriptionEvents(since, until, summary) {
    const activated = await query(`
        SELECT s.id,s.customer_id,s.status,s.source,s.provider_subscription_id,s.created_at,s.current_period_end,
               COALESCE(s.plan_name_snapshot,p.name,'Subscription') plan_name,
               COALESCE(c.display_name,au.username,c.email,'Customer') customer_name
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id
        WHERE s.created_at>$1 AND s.created_at<=$2 AND s.status IN('active','trialing')
        ORDER BY s.created_at,s.id
    `, [since, until]);
    for (const row of activated.rows) {
        const plan = clean(row.plan_name, 200) || 'Subscription';
        await emit(summary, {
            eventType: 'subscription.activated',
            customerId: row.customer_id,
            subject: `${plan} activated`,
            text: `Your ${plan} subscription is active.`,
            adminText: `${clean(row.customer_name, 200)} activated ${plan}.`,
            dedupeKey: `subscription-activated:${row.id}`
        });
    }

    const terminal = await query(`
        SELECT s.id,s.customer_id,s.status,s.current_period_end,s.updated_at,
               COALESCE(s.plan_name_snapshot,p.name,'Subscription') plan_name,
               COALESCE(c.display_name,au.username,c.email,'Customer') customer_name
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id
        WHERE s.updated_at>$1 AND s.updated_at<=$2 AND s.status IN('cancelled','expired')
        ORDER BY s.updated_at,s.id
    `, [since, until]);
    for (const row of terminal.rows) {
        const plan = clean(row.plan_name, 200) || 'Subscription';
        const name = clean(row.customer_name, 200);
        const period = dateKey(row.current_period_end);
        if (row.status === 'cancelled') {
            await emit(summary, {
                eventType: 'subscription.cancelled',
                customerId: row.customer_id,
                subject: `${plan} cancelled`,
                text: `Your ${plan} subscription has been cancelled. Existing paid-through access remains governed by its recorded end date.`,
                adminText: `${name}'s ${plan} subscription was cancelled. Existing paid-through access remains governed by its recorded end date.`,
                dedupeKey: `subscription-cancelled:${row.id}:${period}`
            });
        } else {
            await emit(summary, {
                eventType: 'customer.service.expired',
                customerId: row.customer_id,
                subject: 'Customer service expired',
                text: `${plan} access reached its recorded expiry for customer ${row.customer_id}.`,
                adminText: `${plan} access reached its recorded expiry for ${name}.`,
                dedupeKey: `customer-service-expired:${row.id}:${period}`
            });
        }
    }
}

function paymentReceiptKey(row) {
    const identity = clean(row.provider_subscription_id || row.subscription_id || row.id, 220) || 'unknown';
    return `payment-received:${row.source || row.provider || 'provider'}:${identity}:${dateKey(row.current_period_end)}`;
}

async function paymentReceiptEvents(since, until, summary) {
    const activations = await query(`
        SELECT a.id audit_id,a.created_at,s.id subscription_id,s.customer_id,s.source,s.provider_subscription_id,s.current_period_end,
               COALESCE(s.plan_name_snapshot,p.name,'Subscription') plan_name,
               COALESCE(c.display_name,au.username,c.email,'Customer') customer_name
        FROM audit_log a
        JOIN subscriptions s ON s.id::text=a.entity_id
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id
        WHERE a.action='payment.subscription.activate' AND a.created_at>$1 AND a.created_at<=$2
        ORDER BY a.created_at,a.id
    `, [since, until]);
    for (const row of activations.rows) {
        const plan = clean(row.plan_name, 200) || 'Subscription';
        await emit(summary, {
            eventType: 'payment.received',
            customerId: row.customer_id,
            subject: 'Payment received',
            text: `Payment was confirmed for ${plan} via ${clean(row.source, 40) || 'the payment provider'}.`,
            adminText: `Payment confirmed for ${clean(row.customer_name, 200)} — ${plan} via ${clean(row.source, 40) || 'the payment provider'}.`,
            dedupeKey: paymentReceiptKey(row)
        });
    }

    const stripeInvoices = await query(`
        SELECT id,provider_event_id,payload,processed_at
        FROM payment_events
        WHERE provider='stripe' AND event_type='invoice.paid'
          AND processed_at>$1 AND processed_at<=$2
        ORDER BY processed_at,id
    `, [since, until]);
    for (const event of stripeInvoices.rows) {
        const invoice = event.payload?.data?.object || event.payload || {};
        const direct = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        const parent = invoice.parent?.subscription_details?.subscription;
        const providerSubscriptionId = direct || (typeof parent === 'string' ? parent : parent?.id) || null;
        if (!providerSubscriptionId) continue;
        const subscription = await query(`
            SELECT s.id subscription_id,s.customer_id,s.source,s.provider_subscription_id,s.current_period_end,
                   COALESCE(s.plan_name_snapshot,p.name,'Subscription') plan_name,
                   COALESCE(c.display_name,au.username,c.email,'Customer') customer_name
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id
            WHERE s.source='stripe' AND s.provider_subscription_id=$1
            ORDER BY s.created_at DESC LIMIT 1
        `, [providerSubscriptionId]);
        if (!subscription.rowCount) continue;
        const row = subscription.rows[0];
        const plan = clean(row.plan_name, 200) || 'Subscription';
        await emit(summary, {
            eventType: 'payment.received',
            customerId: row.customer_id,
            subject: 'Payment received',
            text: `Stripe confirmed payment for ${plan}.`,
            adminText: `Stripe confirmed payment for ${clean(row.customer_name, 200)} — ${plan}.`,
            dedupeKey: paymentReceiptKey(row)
        });
    }
}

async function paymentIncidentEvents(since, until, summary) {
    const result = await query(`
        SELECT * FROM payment_incidents
        WHERE created_at>$1 AND created_at<=$2
          AND incident_type IN('refund','dispute','chargeback','failed_renewal')
        ORDER BY created_at,id
    `, [since, until]);
    for (const row of result.rows) {
        const provider = clean(row.provider, 50) || 'payment provider';
        const amount = money(row.amount_minor, row.currency);
        const amountText = amount ? ` (${amount})` : '';
        if (row.incident_type === 'refund') {
            await emit(summary, {
                eventType: 'payment.refunded',
                customerId: row.customer_id,
                subject: 'Payment refunded',
                text: `${provider} recorded a refund${amountText}${row.customer_id ? ` for customer ${row.customer_id}` : ''}.`,
                dedupeKey: `payment-refunded:${row.id}`
            });
            continue;
        }
        if (row.incident_type === 'dispute') {
            if (String(row.incident_status || '').toLowerCase() !== 'open') continue;
            await emit(summary, {
                eventType: 'payment.disputed',
                customerId: row.customer_id,
                subject: 'Payment dispute opened',
                text: `${provider} reported a payment dispute${amountText}${row.customer_id ? ` for customer ${row.customer_id}` : ''}.`,
                dedupeKey: `payment-disputed:${row.id}`
            });
            continue;
        }
        if (row.incident_type === 'chargeback') {
            await emit(summary, {
                eventType: 'payment.chargeback',
                customerId: row.customer_id,
                subject: 'Payment chargeback',
                text: `${provider} recorded a chargeback${amountText}${row.customer_id ? ` for customer ${row.customer_id}` : ''}.`,
                dedupeKey: `payment-chargeback:${row.id}`
            });
            continue;
        }
        await emit(summary, {
            eventType: 'payment.failed',
            customerId: row.customer_id,
            subject: 'Payment failed',
            text: `Your ${provider} renewal payment could not be confirmed${amountText}. Please review your billing method to avoid interruption.`,
            dedupeKey: `payment-failed:${row.id}`
        });
        await emit(summary, {
            eventType: 'payment.renewal_failed',
            customerId: row.customer_id,
            subject: 'Customer renewal failed',
            text: `${provider} reported a failed renewal${amountText}${row.customer_id ? ` for customer ${row.customer_id}` : ''}.`,
            dedupeKey: `payment-renewal-failed:${row.id}`
        });
    }
}

async function planChangeEvents(since, until, summary) {
    const changes = await query(`
        SELECT pc.*,p.name target_plan_name,p.code target_plan_code
        FROM customer_plan_changes pc JOIN plans p ON p.id=pc.target_plan_id
        WHERE pc.updated_at>$1 AND pc.updated_at<=$2
          AND pc.state IN('pending','applied','failed')
          AND (pc.state<>'pending' OR pc.provider<>'stripe' OR pc.provider_schedule_id IS NOT NULL)
        ORDER BY pc.updated_at,pc.id
    `, [since, until]);
    for (const row of changes.rows) {
        const target = clean(row.target_plan_name || row.target_plan_code, 200) || 'target plan';
        if (row.state === 'pending') {
            await emit(summary, {
                eventType: 'customer.plan_change.scheduled',
                customerId: row.customer_id,
                subject: 'Plan change scheduled',
                text: `Customer ${row.customer_id} has a plan change to ${target} scheduled for ${dateKey(row.effective_at)} via ${clean(row.provider, 40)}.`,
                dedupeKey: `plan-change-scheduled:${row.id}`
            });
        } else if (row.state === 'applied') {
            await emit(summary, {
                eventType: 'customer.plan_change.applied',
                customerId: row.customer_id,
                subject: 'Plan change applied',
                text: `Customer ${row.customer_id} was changed to ${target}.`,
                dedupeKey: `plan-change-applied:${row.id}`
            });
        } else {
            await emit(summary, {
                eventType: 'customer.plan_change.failed',
                customerId: row.customer_id,
                subject: 'Plan change failed',
                text: `Plan change to ${target} failed for customer ${row.customer_id}. ${clean(row.error, 700)}`,
                dedupeKey: `plan-change-failed:${row.id}`
            });
        }
    }

    const immediate = await query(`
        SELECT id,entity_id customer_id,metadata,created_at
        FROM audit_log
        WHERE action='customer.plan_change.immediate' AND created_at>$1 AND created_at<=$2
        ORDER BY created_at,id
    `, [since, until]);
    for (const row of immediate.rows) {
        await emit(summary, {
            eventType: 'customer.plan_change.applied',
            customerId: row.customer_id,
            subject: 'Plan change applied',
            text: `An immediate plan change was applied for customer ${row.customer_id}.`,
            dedupeKey: `plan-change-applied:immediate:${row.id}`
        });
    }
}

async function inactivityEvents(since, until, summary) {
    const result = await query(`
        SELECT id,entity_id customer_id,metadata,created_at
        FROM audit_log
        WHERE action='customer.inactivity.disable_jellyfin' AND created_at>$1 AND created_at<=$2
        ORDER BY created_at,id
    `, [since, until]);
    for (const row of result.rows) {
        const triggers = Array.isArray(row.metadata?.triggers) ? row.metadata.triggers.join('; ') : '';
        await emit(summary, {
            eventType: 'customer.service.inactive',
            customerId: row.customer_id,
            subject: 'Customer service disabled for inactivity',
            text: `Jellyfin access was disabled by the configured inactivity policy for customer ${row.customer_id}.${triggers ? ` ${clean(triggers, 700)}` : ''}`,
            dedupeKey: `customer-service-inactive:${row.id}`
        });
    }
}

async function operationalEvents(since, until, summary) {
    const automation = await query(`
        SELECT job_key,last_outcome,last_error,last_warning,last_failed_count,last_success_at,updated_at
        FROM automation_job_state
        WHERE updated_at>$1 AND updated_at<=$2
          AND (last_outcome IN('failed','degraded') OR last_error IS NOT NULL)
        ORDER BY updated_at,job_key
    `, [since, until]);
    for (const row of automation.rows) {
        const detail = clean(row.last_error || row.last_warning, 900);
        await emit(summary, {
            eventType: 'automation.error',
            subject: `Automation issue: ${row.job_key}`,
            text: `Automation ${row.job_key} is ${row.last_outcome || 'unhealthy'}${Number(row.last_failed_count || 0) ? ` with ${Number(row.last_failed_count)} failed operation(s)` : ''}.${detail ? ` ${detail}` : ''}`,
            dedupeKey: `automation-error:${row.job_key}:${dateKey(row.last_success_at)}`
        });
    }

    const provisioning = await query(`
        SELECT cps.customer_id,cps.status,cps.last_error,cps.last_success_at,cps.updated_at,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name
        FROM customer_provisioning_state cps
        JOIN customers c ON c.id=cps.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE cps.updated_at>$1 AND cps.updated_at<=$2 AND cps.status IN('blocked','failed')
        ORDER BY cps.updated_at,cps.customer_id
    `, [since, until]);
    for (const row of provisioning.rows) {
        const name = clean(row.customer_name, 200) || row.customer_id;
        await emit(summary, {
            eventType: 'provisioning.failed',
            customerId: row.customer_id,
            subject: `Provisioning ${row.status}: ${name}`,
            text: `Customer provisioning is ${row.status} for ${name}. ${clean(row.last_error, 900)}`,
            dedupeKey: `provisioning-failed:${row.customer_id}:${dateKey(row.last_success_at)}`
        });
    }
}

async function serverEvents(previousServers, summary) {
    const result = await query(`
        SELECT id,name,health_status,last_health_check
        FROM jellyfin_servers WHERE enabled=TRUE ORDER BY id
    `);
    const next = {};
    for (const row of result.rows) {
        const prior = previousServers[String(row.id)] || null;
        const currentStatus = String(row.health_status || 'unknown');
        const checkedAt = dateKey(row.last_health_check);
        if (currentStatus === 'offline' && prior?.status !== 'offline') {
            await emit(summary, {
                eventType: 'server.offline',
                subject: `Jellyfin server offline: ${clean(row.name, 200) || row.id}`,
                text: `${clean(row.name, 200) || row.id} has crossed the health threshold into offline state.`,
                dedupeKey: `server-offline:${row.id}:${prior?.checkedAt || 'initial'}`
            });
        }
        next[String(row.id)] = { status: currentStatus, checkedAt };
    }
    return next;
}

async function run() {
    const until = new Date();
    const state = await loadState(until);
    const summary = {
        processed: 0,
        queued: 0,
        failed: 0,
        retryQueued: 0,
        retryAttempted: 0,
        retryResolved: 0,
        retryFailed: 0,
        retryPending: 0,
        windowStart: state.cursor.toISOString(),
        windowEnd: until.toISOString()
    };

    // Retry previously failed deterministic notifications first. A retry that
    // still fails degrades this run but no longer rewinds the global discovery
    // cursor or causes an ever-growing historical rescan.
    await processRetries(summary);
    await subscriptionEvents(state.cursor, until, summary);
    await paymentReceiptEvents(state.cursor, until, summary);
    await paymentIncidentEvents(state.cursor, until, summary);
    await planChangeEvents(state.cursor, until, summary);
    await inactivityEvents(state.cursor, until, summary);
    await operationalEvents(state.cursor, until, summary);
    const servers = await serverEvents(state.servers, summary);
    // If durable retry persistence itself failed, emit/processRetries throws and
    // we deliberately do not advance the cursor. Ordinary channel failures are
    // already represented durably and must never pin this global cursor.
    await saveState(until, servers);
    summary.retryPending = await retryPendingCount();
    return summary;
}

module.exports = {
    STATE_KEY,
    INITIAL_LOOKBACK_MS,
    MAX_CATCHUP_MS,
    DEFAULT_RETRY_LIMIT,
    validDate,
    dateKey,
    money,
    loadState,
    saveState,
    retryDelaySeconds,
    retryFailureMessage,
    retryKey,
    queueRetry,
    clearRetry,
    dueRetries,
    markRetryFailure,
    retryPendingCount,
    processRetries,
    paymentReceiptKey,
    run
};
