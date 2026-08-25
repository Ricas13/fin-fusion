'use strict';

const Stripe = require('stripe');
const { query, transaction } = require('../db');
const providerSettings = require('./provider-settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const MAX_TRANSACTIONS = 50000;
const MAX_PROVIDER_PAGES = 2000;
const ZERO_DECIMAL = new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const THREE_DECIMAL = new Set(['BHD','JOD','KWD','OMR','TND']);

function clean(value, max = 500) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function parseDateOnly(value, label) {
    const text = clean(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD.`);
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`${label} is not a valid date.`);
    return date;
}

function validateProviderScope(provider) {
    const value = clean(provider, 10).toLowerCase();
    if (!['stripe', 'paypal', 'both'].includes(value)) throw new Error('Choose Stripe, PayPal or Both.');
    return value;
}

function parseRange({ provider, startDate, endDate }) {
    const scope = validateProviderScope(provider);
    const start = parseDateOnly(startDate, 'Start date');
    const endInclusive = parseDateOnly(endDate, 'End date');
    const endExclusive = new Date(endInclusive.getTime() + DAY_MS);
    const days = (endExclusive.getTime() - start.getTime()) / DAY_MS;
    if (days < 1) throw new Error('End date must be on or after the start date.');
    if (days > MAX_RANGE_DAYS) throw new Error(`Historical imports are limited to ${MAX_RANGE_DAYS} days per run.`);
    return { scope, start, endInclusive, endExclusive, startDate: clean(startDate, 10), endDate: clean(endDate, 10), days };
}

function currencyExponent(currency) {
    const code = clean(currency, 3).toUpperCase();
    if (ZERO_DECIMAL.has(code)) return 0;
    if (THREE_DECIMAL.has(code)) return 3;
    return 2;
}

function majorToMinor(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * (10 ** currencyExponent(currency)));
}

function objectId(value) {
    if (!value) return null;
    return typeof value === 'string' ? clean(value, 255) || null : clean(value.id, 255) || null;
}

function normalizeStripe(row, chargeMap = new Map()) {
    if (!row?.id || !Number.isFinite(Number(row.created))) return null;
    const sourceId = objectId(row.source);
    const charge = sourceId ? chargeMap.get(sourceId) : null;
    const customerId = objectId(charge?.customer);
    const referenceId = objectId(charge?.payment_intent) || objectId(charge?.invoice) || null;
    return {
        provider: 'stripe',
        providerTransactionId: clean(row.id, 255),
        transactionType: clean(row.reporting_category || row.type || 'balance_transaction', 120),
        transactionStatus: clean(row.status || '', 80) || null,
        occurredAt: new Date(Number(row.created) * 1000).toISOString(),
        currency: clean(row.currency || 'GBP', 3).toUpperCase(),
        grossAmountMinor: Number(row.amount || 0),
        feeAmountMinor: Number(row.fee || 0),
        netAmountMinor: Number(row.net == null ? Number(row.amount || 0) - Number(row.fee || 0) : row.net),
        providerCustomerId: customerId,
        providerReferenceId: referenceId,
        providerSourceId: sourceId,
        customerId: null,
        metadata: {
            stripeType: clean(row.type || '', 100) || null,
            reportingCategory: clean(row.reporting_category || '', 100) || null,
            sourceType: clean(charge?.object || (sourceId ? sourceId.split('_')[0] : ''), 60) || null
        }
    };
}

function payPalPayerId(detail) {
    const payer = detail?.payer_info || {};
    return clean(payer.account_id || payer.payer_id || payer.payer_account_id || '', 255) || null;
}

function normalizePayPal(detail) {
    const info = detail?.transaction_info || {};
    const transactionId = clean(info.transaction_id || '', 255);
    const occurredAt = info.transaction_initiation_date || info.transaction_updated_date;
    if (!transactionId || !occurredAt || Number.isNaN(new Date(occurredAt).getTime())) return null;
    const amount = info.transaction_amount || {};
    const fee = info.fee_amount || {};
    const currency = clean(amount.currency_code || fee.currency_code || 'GBP', 3).toUpperCase();
    const gross = majorToMinor(amount.value, currency);
    // Transaction Search reports charged fees as negative values. Convert that
    // to CAPTAiNFiN's positive-cost convention; a provider fee refund remains
    // negative and therefore increases net revenue correctly.
    const rawFee = majorToMinor(fee.value, currency);
    const normalizedFee = -rawFee;
    return {
        provider: 'paypal',
        providerTransactionId: transactionId,
        transactionType: clean(info.transaction_event_code || info.transaction_subject || 'transaction', 120),
        transactionStatus: clean(info.transaction_status || '', 80) || null,
        occurredAt: new Date(occurredAt).toISOString(),
        currency,
        grossAmountMinor: gross,
        feeAmountMinor: normalizedFee,
        netAmountMinor: gross - normalizedFee,
        providerCustomerId: payPalPayerId(detail),
        providerReferenceId: clean(info.paypal_reference_id || '', 255) || null,
        providerSourceId: null,
        customerId: null,
        metadata: {
            eventCode: clean(info.transaction_event_code || '', 40) || null,
            referenceType: clean(info.paypal_reference_id_type || '', 80) || null,
            protectionEligibility: clean(info.protection_eligibility || '', 80) || null
        }
    };
}

function dedupeTransactions(rows) {
    const map = new Map();
    for (const row of rows || []) {
        if (!row?.provider || !row?.providerTransactionId) continue;
        map.set(`${row.provider}:${row.providerTransactionId}`, row);
    }
    return Array.from(map.values()).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
}

function payPalWindows(start, endExclusive) {
    const windows = [];
    let cursor = start.getTime();
    const finalExclusive = endExclusive.getTime();
    while (cursor < finalExclusive) {
        const nextExclusive = Math.min(cursor + (31 * DAY_MS), finalExclusive);
        windows.push({
            start: new Date(cursor),
            end: new Date(nextExclusive - 1)
        });
        cursor = nextExclusive;
    }
    return windows;
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
        const text = await response.text();
        let body = {};
        if (text) {
            try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; }
        }
        return { response, body };
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Payment provider request timed out.');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchStripeCharges(stripe, range) {
    const map = new Map();
    let startingAfter = null;
    let pages = 0;
    while (true) {
        if (++pages > MAX_PROVIDER_PAGES) throw new Error('Stripe charge enrichment exceeded the safety page limit.');
        const page = await stripe.charges.list({
            created: { gte: Math.floor(range.start.getTime() / 1000), lt: Math.floor(range.endExclusive.getTime() / 1000) },
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        for (const charge of page.data || []) if (charge?.id) map.set(charge.id, charge);
        if (!page.has_more || !(page.data || []).length) break;
        startingAfter = page.data[page.data.length - 1].id;
    }
    return map;
}

async function fetchStripeTransactions(range) {
    const config = await providerSettings.getRaw('stripe');
    const key = config.restrictedKey || config.apiKey || '';
    if (!key) throw new Error('Stripe API credentials are not configured.');
    const stripe = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' }, maxNetworkRetries: 2, timeout: 20000 });
    const rows = [];
    const warnings = [];
    let chargeMap = new Map();
    try {
        chargeMap = await fetchStripeCharges(stripe, range);
    } catch (error) {
        warnings.push(`Stripe customer matching was skipped because Charges could not be read: ${clean(error?.message || error, 240)}`);
    }
    let startingAfter = null;
    let pages = 0;
    try {
        while (true) {
            if (++pages > MAX_PROVIDER_PAGES) throw new Error('Stripe history exceeded the safety page limit. Split the date range and try again.');
            const page = await stripe.balanceTransactions.list({
                created: { gte: Math.floor(range.start.getTime() / 1000), lt: Math.floor(range.endExclusive.getTime() / 1000) },
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {})
            });
            for (const item of page.data || []) {
                const normalized = normalizeStripe(item, chargeMap);
                if (normalized) rows.push(normalized);
                if (rows.length > MAX_TRANSACTIONS) throw new Error(`More than ${MAX_TRANSACTIONS.toLocaleString('en-GB')} Stripe transactions were found. Split the import into smaller date ranges.`);
            }
            if (!page.has_more || !(page.data || []).length) break;
            startingAfter = page.data[page.data.length - 1].id;
        }
    } catch (error) {
        if (Number(error?.statusCode) === 403) throw new Error('Stripe historical import needs Balance transactions: Read permission on the configured restricted key.');
        throw error;
    }
    return { transactions: rows, warnings };
}

async function payPalAccessToken(config) {
    if (!config.clientId || !config.clientSecret) throw new Error('PayPal client ID and secret are not configured.');
    const host = config.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const { response, body } = await fetchJson(`${host}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    if (!response.ok || !body?.access_token) throw new Error(`PayPal OAuth failed: ${clean(body?.error_description || body?.message || response.status, 300)}`);
    return { host, token: body.access_token };
}

async function fetchPayPalTransactions(range) {
    const config = await providerSettings.getRaw('paypal');
    const { host, token } = await payPalAccessToken(config);
    const rows = [];
    for (const window of payPalWindows(range.start, range.endExclusive)) {
        let page = 1;
        while (true) {
            if (page > MAX_PROVIDER_PAGES) throw new Error('PayPal history exceeded the safety page limit. Split the date range and try again.');
            const url = new URL(`${host}/v1/reporting/transactions`);
            url.searchParams.set('start_date', window.start.toISOString());
            url.searchParams.set('end_date', window.end.toISOString());
            url.searchParams.set('fields', 'all');
            url.searchParams.set('page_size', '500');
            url.searchParams.set('page', String(page));
            const { response, body } = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
            if (!response.ok) {
                if (response.status === 403) throw new Error('PayPal historical import needs the Transactions Search reporting permission (reporting/search/read) on the configured REST app.');
                throw new Error(`PayPal Transaction Search failed (HTTP ${response.status}): ${clean(body?.message || body?.name || 'request failed', 300)}`);
            }
            for (const detail of body.transaction_details || []) {
                const normalized = normalizePayPal(detail);
                if (normalized) rows.push(normalized);
                if (rows.length > MAX_TRANSACTIONS) throw new Error(`More than ${MAX_TRANSACTIONS.toLocaleString('en-GB')} PayPal transactions were found. Split the import into smaller date ranges.`);
            }
            const totalPages = Math.max(1, Number(body.total_pages || 1));
            if (page >= totalPages || !(body.transaction_details || []).length) break;
            page += 1;
        }
    }
    return { transactions: rows, warnings: config.environment === 'live' ? [] : ['PayPal is configured for Sandbox, so this preview/import contains Sandbox history only.'] };
}

async function matchCustomers(rows) {
    if (!(rows || []).length) return rows || [];
    const providers = Array.from(new Set(rows.map(row => row.provider)));
    const mappings = await query(`SELECT customer_id,provider,provider_customer_id FROM payment_customers WHERE provider=ANY($1::text[])`, [providers]);
    const byIdentity = new Map();
    for (const mapping of mappings.rows) {
        const key = `${mapping.provider}:${mapping.provider_customer_id}`;
        if (!byIdentity.has(key)) byIdentity.set(key, new Set());
        byIdentity.get(key).add(String(mapping.customer_id));
    }
    return rows.map(row => {
        if (!row.providerCustomerId) return row;
        const candidates = byIdentity.get(`${row.provider}:${row.providerCustomerId}`);
        return { ...row, customerId: candidates?.size === 1 ? Array.from(candidates)[0] : null };
    });
}

async function existingKeySet(rows, db = { query }) {
    if (!(rows || []).length) return new Set();
    const keys = rows.map(row => ({ provider: row.provider, provider_transaction_id: row.providerTransactionId }));
    const found = await db.query(`
        SELECT h.provider,h.provider_transaction_id
        FROM payment_history_transactions h
        JOIN jsonb_to_recordset($1::jsonb) AS x(provider text, provider_transaction_id text)
          ON x.provider=h.provider AND x.provider_transaction_id=h.provider_transaction_id`, [JSON.stringify(keys)]);
    return new Set(found.rows.map(row => `${row.provider}:${row.provider_transaction_id}`));
}

function summarize(rows, existing = new Set(), warnings = []) {
    const byProvider = {};
    const byCurrency = {};
    let matched = 0;
    for (const row of rows) {
        byProvider[row.provider] = (byProvider[row.provider] || 0) + 1;
        if (row.customerId) matched += 1;
        const currency = row.currency || 'UNKNOWN';
        const bucket = byCurrency[currency] || { grossAmountMinor: 0, feeAmountMinor: 0, netAmountMinor: 0, transactions: 0 };
        bucket.grossAmountMinor += Number(row.grossAmountMinor || 0);
        bucket.feeAmountMinor += Number(row.feeAmountMinor || 0);
        bucket.netAmountMinor += Number(row.netAmountMinor || 0);
        bucket.transactions += 1;
        byCurrency[currency] = bucket;
    }
    const existingCount = rows.filter(row => existing.has(`${row.provider}:${row.providerTransactionId}`)).length;
    return {
        total: rows.length,
        newCount: rows.length - existingCount,
        existingCount,
        matchedCount: matched,
        unmatchedCount: rows.length - matched,
        byProvider,
        byCurrency,
        warnings: warnings.filter(Boolean)
    };
}

async function loadHistory(input) {
    const range = parseRange(input);
    const providers = range.scope === 'both' ? ['stripe', 'paypal'] : [range.scope];
    const fetched = await Promise.all(providers.map(provider => provider === 'stripe' ? fetchStripeTransactions(range) : fetchPayPalTransactions(range)));
    const warnings = fetched.flatMap(result => result.warnings || []);
    let rows = dedupeTransactions(fetched.flatMap(result => result.transactions || []));
    rows = await matchCustomers(rows);
    const existing = await existingKeySet(rows);
    return { range, rows, existing, summary: summarize(rows, existing, warnings) };
}

async function preview(input) {
    const result = await loadHistory(input);
    return { range: result.range, summary: result.summary, sample: result.rows.slice(0, 25) };
}

function dbRows(rows) {
    return rows.map(row => ({
        provider: row.provider,
        provider_transaction_id: row.providerTransactionId,
        transaction_type: row.transactionType,
        transaction_status: row.transactionStatus,
        occurred_at: row.occurredAt,
        currency: row.currency,
        gross_amount_minor: row.grossAmountMinor,
        fee_amount_minor: row.feeAmountMinor,
        net_amount_minor: row.netAmountMinor,
        provider_customer_id: row.providerCustomerId,
        provider_reference_id: row.providerReferenceId,
        provider_source_id: row.providerSourceId,
        customer_id: row.customerId,
        metadata: row.metadata || {}
    }));
}

async function importHistory(input, actorUserId = null) {
    const loaded = await loadHistory(input);
    const result = await transaction(async client => {
        const existing = await existingKeySet(loaded.rows, client);
        const actualSummary = summarize(loaded.rows, existing, loaded.summary.warnings);
        const run = await client.query(`
            INSERT INTO payment_history_import_runs(provider_scope,range_start,range_end,total_seen,imported_count,existing_count,matched_count,unmatched_count,requested_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id,created_at`, [loaded.range.scope, loaded.range.startDate, loaded.range.endDate, actualSummary.total, actualSummary.newCount, actualSummary.existingCount, actualSummary.matchedCount, actualSummary.unmatchedCount, actorUserId]);
        const runId = run.rows[0].id;
        if (loaded.rows.length) {
            await client.query(`
                INSERT INTO payment_history_transactions(
                    provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
                    gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,provider_reference_id,
                    provider_source_id,customer_id,first_import_run_id,last_import_run_id,metadata)
                SELECT x.provider,x.provider_transaction_id,x.transaction_type,x.transaction_status,x.occurred_at,x.currency,
                       x.gross_amount_minor,x.fee_amount_minor,x.net_amount_minor,x.provider_customer_id,x.provider_reference_id,
                       x.provider_source_id,x.customer_id,$1,$1,COALESCE(x.metadata,'{}'::jsonb)
                FROM jsonb_to_recordset($2::jsonb) AS x(
                    provider text,provider_transaction_id text,transaction_type text,transaction_status text,
                    occurred_at timestamptz,currency text,gross_amount_minor bigint,fee_amount_minor bigint,net_amount_minor bigint,
                    provider_customer_id text,provider_reference_id text,provider_source_id text,customer_id uuid,metadata jsonb)
                ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
                    transaction_type=EXCLUDED.transaction_type,
                    transaction_status=EXCLUDED.transaction_status,
                    occurred_at=EXCLUDED.occurred_at,
                    currency=EXCLUDED.currency,
                    gross_amount_minor=EXCLUDED.gross_amount_minor,
                    fee_amount_minor=EXCLUDED.fee_amount_minor,
                    net_amount_minor=EXCLUDED.net_amount_minor,
                    provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,payment_history_transactions.provider_customer_id),
                    provider_reference_id=COALESCE(EXCLUDED.provider_reference_id,payment_history_transactions.provider_reference_id),
                    provider_source_id=COALESCE(EXCLUDED.provider_source_id,payment_history_transactions.provider_source_id),
                    customer_id=COALESCE(EXCLUDED.customer_id,payment_history_transactions.customer_id),
                    last_import_run_id=$1,
                    metadata=EXCLUDED.metadata,
                    updated_at=NOW()`, [runId, JSON.stringify(dbRows(loaded.rows))]);
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_history.import','payment_history_import',$2,$3::jsonb)`, [actorUserId, runId, JSON.stringify({ provider: loaded.range.scope, startDate: loaded.range.startDate, endDate: loaded.range.endDate, total: actualSummary.total, imported: actualSummary.newCount, existing: actualSummary.existingCount, matched: actualSummary.matchedCount })]);
        return { runId, createdAt: run.rows[0].created_at, summary: actualSummary };
    });
    return { range: loaded.range, ...result };
}

async function recentRuns(limit = 12) {
    const n = Math.max(1, Math.min(50, Number(limit) || 12));
    const result = await query(`SELECT id,provider_scope,range_start,range_end,status,total_seen,imported_count,existing_count,matched_count,unmatched_count,created_at,completed_at FROM payment_history_import_runs ORDER BY created_at DESC LIMIT $1`, [n]);
    return result.rows;
}

async function ledgerSummary() {
    const result = await query(`SELECT provider,currency,COUNT(*)::int transactions,COALESCE(SUM(gross_amount_minor),0)::bigint gross_amount_minor,COALESCE(SUM(fee_amount_minor),0)::bigint fee_amount_minor,COALESCE(SUM(net_amount_minor),0)::bigint net_amount_minor,MIN(occurred_at) first_at,MAX(occurred_at) last_at FROM payment_history_transactions GROUP BY provider,currency ORDER BY provider,currency`);
    return result.rows;
}

module.exports = {
    MAX_RANGE_DAYS,
    parseRange,
    majorToMinor,
    normalizeStripe,
    normalizePayPal,
    dedupeTransactions,
    payPalWindows,
    summarize,
    preview,
    importHistory,
    recentRuns,
    ledgerSummary
};
