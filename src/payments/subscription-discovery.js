'use strict';

const Stripe = require('stripe');
const { query, transaction } = require('../db');
const providerSettings = require('./provider-settings');
const lifecycle = require('./lifecycle-primitives');
const subscriptionState = require('../entitlements/subscription-state');

const MAX_REMOTE_SUBSCRIPTIONS = 5000;
const MAX_PROVIDER_PAGES = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAYPAL_DISCOVERY_DAYS = 1095;
const PAYPAL_TRANSACTION_TYPES = Object.freeze(['T0002', 'T0003']);
const STRIPE_CURRENT = new Set(['active', 'trialing', 'past_due', 'paused', 'unpaid']);
const PAYPAL_CURRENT = new Set(['ACTIVE', 'SUSPENDED']);

function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function emailKey(value) { return clean(value, 320).toLowerCase(); }
function objectId(value) { return typeof value === 'string' ? clean(value, 255) : clean(value?.id, 255); }
function recurringId(provider, id) {
    const value = clean(id, 255);
    return (provider === 'stripe' && /^sub_/i.test(value)) || (provider === 'paypal' && /^I-/i.test(value));
}
function currentRemote(remote) {
    if (remote?.provider === 'stripe') return STRIPE_CURRENT.has(String(remote.status || '').toLowerCase());
    if (remote?.provider === 'paypal') return PAYPAL_CURRENT.has(String(remote.status || '').toUpperCase());
    return false;
}

function stripePeriod(subscription) {
    const ends = (subscription?.items?.data || []).map(item => Number(item.current_period_end)).filter(Number.isFinite);
    const end = ends.length ? Math.max(...ends) : Number(subscription?.current_period_end);
    return Number.isFinite(end) ? new Date(end * 1000) : null;
}
function normalizeStripeSubscription(subscription, customer = null) {
    const customerObject = customer || (subscription?.customer && typeof subscription.customer === 'object' ? subscription.customer : null);
    return {
        provider: 'stripe',
        id: clean(subscription?.id, 255),
        providerCustomerId: objectId(subscription?.customer),
        email: clean(customerObject?.email, 320) || null,
        status: clean(subscription?.status, 60).toLowerCase(),
        periodEnd: stripePeriod(subscription),
        cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
        externalPlanIds: Array.from(new Set((subscription?.items?.data || []).map(item => objectId(item?.price)).filter(Boolean))),
        rawPlanId: null
    };
}
function normalizePayPalSubscription(subscription) {
    const next = subscription?.billing_info?.next_billing_time ? new Date(subscription.billing_info.next_billing_time) : null;
    return {
        provider: 'paypal',
        id: clean(subscription?.id, 255),
        providerCustomerId: clean(subscription?.subscriber?.payer_id, 255) || null,
        email: clean(subscription?.subscriber?.email_address, 320) || null,
        status: clean(subscription?.status, 60).toUpperCase(),
        periodEnd: next && !Number.isNaN(next.getTime()) ? next : null,
        cancelAtPeriodEnd: String(subscription?.status || '').toUpperCase() === 'CANCELLED',
        externalPlanIds: clean(subscription?.plan_id, 255) ? [clean(subscription.plan_id, 255)] : [],
        rawPlanId: clean(subscription?.plan_id, 255) || null
    };
}

async function premiumEntitlements() {
    const result = await query(`
        SELECT e.customer_id,e.subscription_id,e.plan_id,e.status,e.source,e.current_period_end,e.cancel_at_period_end,
               e.provider_customer_id,e.provider_subscription_id,e.server_class,
               COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type) AS service_type,
               COALESCE(e.price_minor_snapshot,e.price_minor,0) AS price_minor,
               COALESCE(NULLIF(e.plan_name_snapshot,''),e.name) AS plan_name,
               COALESCE(NULLIF(e.plan_code_snapshot,''),e.code) AS plan_code,
               c.email,c.display_name,u.username AS portal_username
          FROM effective_customer_entitlements e
          JOIN customers c ON c.id=e.customer_id
          LEFT JOIN app_users u ON u.id=c.user_id
         WHERE e.server_class='premium'
           AND COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type) IN ('jellyfin','bundle')
           AND COALESCE(e.price_minor_snapshot,e.price_minor,0)>0
           AND COALESCE(e.is_free_tier,FALSE)=FALSE
         ORDER BY c.email,e.customer_id
    `);
    return result.rows;
}

async function identityContext(premiumRows) {
    const [paymentCustomers, localProviderIds, mappings, existing] = await Promise.all([
        query(`SELECT customer_id,provider,provider_customer_id FROM payment_customers WHERE provider IN ('stripe','paypal')`),
        query(`SELECT customer_id,source AS provider,provider_customer_id FROM subscriptions WHERE source IN ('stripe','paypal') AND provider_customer_id IS NOT NULL`),
        query(`SELECT provider,external_id,plan_id,active FROM plan_provider_prices WHERE provider IN ('stripe','paypal') AND checkout_mode='subscription' AND external_id IS NOT NULL`),
        query(`SELECT id,customer_id,source,provider_subscription_id FROM subscriptions WHERE source IN ('stripe','paypal') AND provider_subscription_id IS NOT NULL`)
    ]);
    const providerIdentityToCustomers = new Map();
    const addIdentity = row => {
        if (!row.provider_customer_id) return;
        const key = `${row.provider}:${row.provider_customer_id}`;
        if (!providerIdentityToCustomers.has(key)) providerIdentityToCustomers.set(key, new Set());
        providerIdentityToCustomers.get(key).add(String(row.customer_id));
    };
    paymentCustomers.rows.forEach(addIdentity);
    localProviderIds.rows.forEach(addIdentity);

    const emailToCustomers = new Map();
    for (const row of premiumRows) {
        const key = emailKey(row.email);
        if (!key) continue;
        if (!emailToCustomers.has(key)) emailToCustomers.set(key, new Set());
        emailToCustomers.get(key).add(String(row.customer_id));
    }

    const externalToPlans = new Map();
    for (const row of mappings.rows) {
        const key = `${row.provider}:${row.external_id}`;
        if (!externalToPlans.has(key)) externalToPlans.set(key, new Set());
        externalToPlans.get(key).add(String(row.plan_id));
    }
    const providerSubscriptionOwners = new Map();
    for (const row of existing.rows) {
        if (!recurringId(row.source, row.provider_subscription_id)) continue;
        providerSubscriptionOwners.set(`${row.source}:${row.provider_subscription_id}`, { subscriptionId: String(row.id), customerId: String(row.customer_id) });
    }
    return { providerIdentityToCustomers, emailToCustomers, externalToPlans, providerSubscriptionOwners };
}

function mappedPlans(remote, context) {
    const plans = new Set();
    for (const external of remote.externalPlanIds || []) {
        const found = context.externalToPlans.get(`${remote.provider}:${external}`);
        for (const id of found || []) plans.add(id);
    }
    return plans;
}
function customerEvidence(remote, local, context) {
    const reasons = [];
    if (remote.providerCustomerId) {
        const mapped = context.providerIdentityToCustomers.get(`${remote.provider}:${remote.providerCustomerId}`);
        if (mapped?.size === 1 && mapped.has(String(local.customer_id))) reasons.push('provider customer ID');
        if (clean(local.provider_customer_id) && clean(local.provider_customer_id) === remote.providerCustomerId) reasons.push('subscription customer ID');
    }
    const remoteEmail = emailKey(remote.email), localEmail = emailKey(local.email);
    if (remoteEmail && localEmail && remoteEmail === localEmail) {
        const owners = context.emailToCustomers.get(remoteEmail);
        if (owners?.size === 1 && owners.has(String(local.customer_id))) reasons.push('unique customer email');
    }
    return Array.from(new Set(reasons));
}

function matchPremiumRows(premiumRows, remotes, context) {
    const rows = [];
    for (const local of premiumRows) {
        if (recurringId(local.source, local.provider_subscription_id)) {
            rows.push({ local, state: 'linked', candidates: [], match: null, reason: 'Already linked to a recurring provider subscription.' });
            continue;
        }
        const candidateDetails = [];
        for (const remote of remotes.filter(currentRemote)) {
            const plans = mappedPlans(remote, context);
            const planMatch = plans.has(String(local.plan_id));
            const customerReasons = customerEvidence(remote, local, context);
            const owner = context.providerSubscriptionOwners.get(`${remote.provider}:${remote.id}`);
            const conflict = owner && owner.subscriptionId !== String(local.subscription_id);
            if (planMatch && customerReasons.length) {
                candidateDetails.push({ remote, customerReasons, planMatch, conflict, owner });
            }
        }
        const nonConflicting = candidateDetails.filter(item => !item.conflict);
        if (nonConflicting.length === 1) {
            rows.push({ local, state: 'safe', candidates: candidateDetails, match: nonConflicting[0].remote, reason: `Exact plan plus ${nonConflicting[0].customerReasons.join(' + ')}.` });
        } else if (nonConflicting.length > 1) {
            rows.push({ local, state: 'ambiguous', candidates: candidateDetails, match: null, reason: `${nonConflicting.length} current provider subscriptions match this premium user.` });
        } else if (candidateDetails.some(item => item.conflict)) {
            rows.push({ local, state: 'conflict', candidates: candidateDetails, match: null, reason: 'A matching provider subscription is already attached to another local subscription.' });
        } else {
            const sameCustomer = remotes.filter(currentRemote).filter(remote => customerEvidence(remote, local, context).length);
            const samePlan = remotes.filter(currentRemote).filter(remote => mappedPlans(remote, context).has(String(local.plan_id)));
            const reason = sameCustomer.length ? 'Provider customer matched, but no current subscription maps to this local plan.' : samePlan.length ? 'Plan matched, but provider customer identity did not resolve uniquely to this user.' : 'No current provider subscription matched both this premium user and plan.';
            rows.push({ local, state: 'unresolved', candidates: [], match: null, reason });
        }
    }
    return rows;
}

async function stripeRemoteSubscriptions() {
    const cfg = await providerSettings.getRaw('stripe');
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) return { remotes: [], warnings: ['Stripe credentials are not configured.'] };
    const stripe = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' }, maxNetworkRetries: 2, timeout: 20000 });
    const remotes = [], warnings = [];
    let cursor = null, pages = 0;
    try {
        while (true) {
            if (++pages > MAX_PROVIDER_PAGES) throw new Error('Stripe subscription discovery exceeded the safety page limit.');
            const page = await stripe.subscriptions.list({ status: 'all', limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
            for (const sub of page.data || []) {
                let customer = null;
                const customerId = objectId(sub.customer);
                if (customerId) {
                    try { customer = await stripe.customers.retrieve(customerId); }
                    catch { /* Customer read is optional; provider customer ID matching still works. */ }
                }
                const normalized = normalizeStripeSubscription(sub, customer?.deleted ? null : customer);
                if (normalized.id) remotes.push(normalized);
                if (remotes.length > MAX_REMOTE_SUBSCRIPTIONS) throw new Error(`More than ${MAX_REMOTE_SUBSCRIPTIONS} Stripe subscriptions were found; narrow the account before discovery.`);
            }
            if (!page.has_more || !(page.data || []).length) break;
            cursor = page.data[page.data.length - 1].id;
        }
    } catch (error) {
        if (Number(error?.statusCode) === 403) warnings.push('Stripe discovery needs Subscriptions: Read permission on the configured restricted key.');
        else warnings.push(`Stripe discovery failed: ${clean(error?.message || error, 300)}`);
    }
    return { remotes, warnings };
}

function paypalHost(cfg) { return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken(cfg) {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal client ID and secret are not configured.');
    const response = await fetch(`${paypalHost(cfg)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw new Error(`PayPal OAuth failed: ${body.error_description || response.status}`);
    return body.access_token;
}
async function paypalJson(cfg, token, path) {
    const response = await fetch(`${paypalHost(cfg)}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'PayPal-Enforce-ISO8601-Format': 'true' } });
    const text = await response.text();
    let body = {};
    if (text) { try { body = JSON.parse(text); } catch { body = { message: text }; } }
    if (!response.ok) throw Object.assign(new Error(body.message || body.name || `PayPal HTTP ${response.status}`), { statusCode: response.status });
    return body;
}
function paypalWindows(start, end) {
    const windows = [];
    let cursor = start.getTime();
    while (cursor < end.getTime()) {
        const next = Math.min(cursor + 31 * DAY_MS, end.getTime());
        windows.push({ start: new Date(cursor), end: new Date(next - 1) });
        cursor = next;
    }
    return windows;
}
async function storedPayPalSubscriptionRefs() {
    const result = await query(`
        SELECT DISTINCT provider_reference_id
          FROM payment_history_transactions
         WHERE provider='paypal'
           AND provider_reference_id IS NOT NULL
           AND metadata->>'referenceType'='SUB'
    `);
    return new Set(result.rows.map(row => clean(row.provider_reference_id, 255)).filter(id => /^I-/i.test(id)));
}
async function discoverPayPalRefs(cfg, token, refs, warnings) {
    const end = new Date();
    const start = new Date(end.getTime() - PAYPAL_DISCOVERY_DAYS * DAY_MS);
    let pages = 0;
    for (const transactionType of PAYPAL_TRANSACTION_TYPES) {
        for (const window of paypalWindows(start, end)) {
            let page = 1;
            while (true) {
                if (++pages > MAX_PROVIDER_PAGES) throw new Error('PayPal subscription discovery exceeded the safety page limit.');
                const params = new URLSearchParams({
                    start_date: window.start.toISOString(), end_date: window.end.toISOString(), fields: 'all',
                    transaction_type: transactionType, transaction_status: 'S', balance_affecting_records_only: 'Y',
                    page_size: '500', page: String(page)
                });
                let body;
                try { body = await paypalJson(cfg, token, `/v1/reporting/transactions?${params.toString()}`); }
                catch (error) {
                    if (Number(error.statusCode) === 403) {
                        warnings.push('PayPal discovery could not scan historical subscription payments because Transaction Search reporting access is unavailable; imported SUB references will still be used.');
                        return;
                    }
                    throw error;
                }
                for (const detail of body.transaction_details || []) {
                    const info = detail.transaction_info || {};
                    if (String(info.paypal_reference_id_type || '').toUpperCase() === 'SUB' && /^I-/i.test(String(info.paypal_reference_id || ''))) refs.add(clean(info.paypal_reference_id, 255));
                }
                if (page >= Math.max(1, Number(body.total_pages || 1)) || !(body.transaction_details || []).length) break;
                page += 1;
            }
        }
    }
}
async function paypalRemoteSubscriptions() {
    const cfg = await providerSettings.getRaw('paypal');
    if (!cfg.clientId || !cfg.clientSecret) return { remotes: [], warnings: ['PayPal credentials are not configured.'] };
    const warnings = cfg.environment === 'live' ? [] : ['PayPal is configured for Sandbox; discovery is scanning Sandbox subscriptions only.'];
    const remotes = [];
    try {
        const token = await paypalToken(cfg);
        const refs = await storedPayPalSubscriptionRefs();
        try { await discoverPayPalRefs(cfg, token, refs, warnings); }
        catch (error) { warnings.push(`PayPal subscription-reference discovery failed: ${clean(error?.message || error, 300)}`); }
        for (const id of refs) {
            if (remotes.length >= MAX_REMOTE_SUBSCRIPTIONS) { warnings.push(`PayPal discovery stopped after ${MAX_REMOTE_SUBSCRIPTIONS} subscription IDs.`); break; }
            try {
                const sub = await paypalJson(cfg, token, `/v1/billing/subscriptions/${encodeURIComponent(id)}?fields=plan`);
                const normalized = normalizePayPalSubscription(sub);
                if (normalized.id) remotes.push(normalized);
            } catch (error) {
                if (![404, 422].includes(Number(error.statusCode))) warnings.push(`PayPal subscription ${id} could not be verified: ${clean(error.message, 180)}`);
            }
        }
    } catch (error) {
        warnings.push(`PayPal discovery failed: ${clean(error?.message || error, 300)}`);
    }
    return { remotes, warnings };
}

function summarizeMatches(rows, remotes, warnings) {
    const counts = { premium: rows.length, linked: 0, safe: 0, ambiguous: 0, conflict: 0, unresolved: 0 };
    for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
    return { rows, remotes, warnings, counts, currentRemote: remotes.filter(currentRemote).length };
}
async function preview() {
    const premium = await premiumEntitlements();
    const context = await identityContext(premium);
    const [stripe, paypal] = await Promise.all([stripeRemoteSubscriptions(), paypalRemoteSubscriptions()]);
    const remotes = [...stripe.remotes, ...paypal.remotes];
    return summarizeMatches(matchPremiumRows(premium, remotes, context), remotes, [...stripe.warnings, ...paypal.warnings]);
}
async function coverageStats() {
    const premium = await premiumEntitlements();
    const linked = premium.filter(row => recurringId(row.source, row.provider_subscription_id)).length;
    return { premium: premium.length, linked, missing: premium.length - linked };
}

async function revalidatePlanMatch(client, local, remote) {
    const result = await client.query(`SELECT DISTINCT plan_id FROM plan_provider_prices WHERE provider=$1 AND checkout_mode='subscription' AND external_id=ANY($2::text[])`, [remote.provider, remote.externalPlanIds || []]);
    const plans = new Set(result.rows.map(row => String(row.plan_id)));
    if (!plans.has(String(local.plan_id))) throw new Error('Provider subscription no longer maps to the local premium plan.');
    return (remote.externalPlanIds || []).find(external => true) || null;
}
async function linkOne(item, actorUserId) {
    const remote = item.match;
    if (!remote || item.state !== 'safe' || !currentRemote(remote)) throw new Error('Only current, unambiguous provider matches can be linked automatically.');
    const linked = await transaction(async client => {
        const localResult = await client.query(`SELECT s.*,p.is_addon,p.server_class,p.service_type,p.price_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=$1 FOR UPDATE`, [item.local.subscription_id]);
        const local = localResult.rows[0];
        if (!local) throw new Error('Local premium subscription disappeared.');
        if (local.server_class !== 'premium' || !['jellyfin','bundle'].includes(local.service_type) || Number(local.price_minor) <= 0) throw new Error('Local subscription is no longer a paid premium Jellyfin entitlement.');
        if (subscriptionState.recurringProvider(local)) {
            if (local.source === remote.provider && local.provider_subscription_id === remote.id) return { row: local, already: true };
            throw new Error('Local subscription became linked to another provider subscription.');
        }
        const duplicate = await client.query(`SELECT id,customer_id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 AND id<>$3 LIMIT 1 FOR UPDATE`, [remote.provider, remote.id, local.id]);
        if (duplicate.rowCount) throw new Error('Provider subscription is already attached to another local subscription.');
        await subscriptionState.assertNoOtherLiveRecurring(client, local.customer_id, local.id, local.plan_id);
        const providerPriceId = await revalidatePlanMatch(client, local, remote);
        const mappedStatus = lifecycle.mapProviderStatus(remote.provider, remote.status);
        const updated = await client.query(`
            UPDATE subscriptions
               SET source=$2,provider_customer_id=COALESCE($3,provider_customer_id),provider_subscription_id=$4,
                   provider_price_id_snapshot=COALESCE($5,provider_price_id_snapshot),status=$6,
                   current_period_end=COALESCE($7,current_period_end),cancel_at_period_end=$8,updated_at=NOW()
             WHERE id=$1 RETURNING *
        `, [local.id, remote.provider, remote.providerCustomerId, remote.id, providerPriceId, mappedStatus, remote.periodEnd, Boolean(remote.cancelAtPeriodEnd)]);
        const row = updated.rows[0];
        await lifecycle.syncProviderAccessState({ customerId: row.customer_id, provider: remote.provider, providerSubscriptionId: remote.id, status: mappedStatus }, client);
        const now = new Date(), next = new Date(now.getTime() + 6 * 60 * 60 * 1000);
        await client.query(`
            INSERT INTO subscription_provider_sync(subscription_id,provider,remote_status,remote_period_end,remote_cancel_at_period_end,last_attempt_at,last_success_at,last_error,consecutive_failures,next_attempt_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$6,NULL,0,$7,NOW())
            ON CONFLICT(subscription_id) DO UPDATE SET provider=EXCLUDED.provider,remote_status=EXCLUDED.remote_status,remote_period_end=EXCLUDED.remote_period_end,remote_cancel_at_period_end=EXCLUDED.remote_cancel_at_period_end,last_attempt_at=EXCLUDED.last_attempt_at,last_success_at=EXCLUDED.last_success_at,last_error=NULL,consecutive_failures=0,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=NOW()
        `, [row.id, remote.provider, remote.status, remote.periodEnd, Boolean(remote.cancelAtPeriodEnd), now, next]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.billing.subscription_discovery.link','subscription',$2,$3::jsonb)`, [actorUserId, row.id, JSON.stringify({ customerId: row.customer_id, provider: remote.provider, providerCustomerId: remote.providerCustomerId, providerSubscriptionId: remote.id, providerPlanIds: remote.externalPlanIds, remoteStatus: remote.status, matchReason: item.reason })]);
        return { row, already: false };
    });
    if (remote.providerCustomerId) await lifecycle.ensurePaymentCustomer({ customerId: linked.row.customer_id, provider: remote.provider, providerCustomerId: remote.providerCustomerId });
    await lifecycle.reconcileCommittedCustomer(linked.row.customer_id, 'Provider subscription discovery');
    return linked;
}
async function apply(actorUserId) {
    const result = await preview();
    const summary = { premium: result.counts.premium, linkedBefore: result.counts.linked, safeFound: result.counts.safe, linked: 0, failed: 0, unresolved: result.counts.ambiguous + result.counts.conflict + result.counts.unresolved, failures: [], warnings: result.warnings };
    for (const item of result.rows.filter(row => row.state === 'safe')) {
        try { const linked = await linkOne(item, actorUserId); if (!linked.already) summary.linked += 1; }
        catch (error) { summary.failed += 1; summary.failures.push({ customerId: item.local.customer_id, error: clean(error?.message || error, 300) }); }
    }
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.billing.subscription_discovery.run','billing','premium-subscription-discovery',$2::jsonb)`, [actorUserId, JSON.stringify(summary)]);
    return summary;
}

module.exports = {
    MAX_REMOTE_SUBSCRIPTIONS,
    PAYPAL_DISCOVERY_DAYS,
    PAYPAL_TRANSACTION_TYPES,
    recurringId,
    currentRemote,
    normalizeStripeSubscription,
    normalizePayPalSubscription,
    matchPremiumRows,
    preview,
    apply,
    coverageStats,
    premiumEntitlements
};
