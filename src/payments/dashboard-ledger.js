'use strict';

const { query } = require('../db');
const { revenueFromEvent, bucketKey, fillSeries } = require('../platform/admin-dashboard-analytics');

const STRIPE_PAYMENT_CATEGORIES = new Set(['charge']);
const STRIPE_REFUND_CATEGORIES = new Set(['refund']);
const PAYPAL_PAYMENT_CODES = new Set([
    'T0000', 'T0002', 'T0003', 'T0005', 'T0006', 'T0007',
    'T0011', 'T0012', 'T0018', 'T0019', 'T0022', 'T0023'
]);
const PAYPAL_REFUND_CODES = new Set(['T1107', 'T1120']);

function refundFromEvent(row) {
    const payload = row?.payload || {};
    if (row?.provider === 'stripe' && row.event_type === 'charge.refunded') {
        const object = payload?.data?.object;
        const amount = Number(object?.amount_refunded);
        if (!object || !Number.isFinite(amount) || amount <= 0) return null;
        return { minor: amount, currency: String(object.currency || 'USD').toUpperCase() };
    }
    if (row?.provider === 'paypal' && row.event_type === 'PAYMENT.SALE.REFUNDED') {
        const resource = payload.resource || {};
        const text = String(resource.amount?.total ?? '').trim();
        if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
        const [whole, fraction = ''] = text.split('.');
        const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
        if (minor <= 0) return null;
        return { minor, currency: String(resource.amount?.currency || 'USD').toUpperCase() };
    }
    return null;
}

function dateStart(value) {
    const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function providersForScope(scope) {
    return scope === 'both' ? ['stripe', 'paypal'] : ['stripe', 'paypal'].includes(scope) ? [scope] : [];
}

function coverageFromRuns(runs) {
    const coverage = { stripe: [], paypal: [] };
    for (const run of runs || []) {
        const start = dateStart(run.range_start);
        const endInclusive = dateStart(run.range_end);
        if (!start || !endInclusive) continue;
        let end = new Date(endInclusive.getTime() + 86400000);
        const completedAt = run.completed_at ? new Date(run.completed_at) : null;
        if (completedAt && !Number.isNaN(completedAt.getTime()) && completedAt >= start && completedAt < end) end = completedAt;
        if (end <= start) continue;
        for (const provider of providersForScope(String(run.provider_scope || '').toLowerCase())) {
            coverage[provider].push({ start, end });
        }
    }
    for (const provider of Object.keys(coverage)) {
        coverage[provider].sort((a, b) => a.start - b.start);
        const merged = [];
        for (const interval of coverage[provider]) {
            const last = merged[merged.length - 1];
            if (last && interval.start <= last.end) {
                if (interval.end > last.end) last.end = interval.end;
            } else {
                merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
            }
        }
        coverage[provider] = merged;
    }
    return coverage;
}

function isCovered(coverage, provider, at) {
    const when = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(when.getTime())) return false;
    return (coverage?.[provider] || []).some(interval => when >= interval.start && when < interval.end);
}

function historyKind(row) {
    const provider = String(row?.provider || '').toLowerCase();
    const type = String(row?.transaction_type || '').trim();
    const gross = Number(row?.gross_amount_minor || 0);
    if (provider === 'stripe') {
        const category = type.toLowerCase();
        if (gross > 0 && STRIPE_PAYMENT_CATEGORIES.has(category)) return 'payment';
        if (gross < 0 && STRIPE_REFUND_CATEGORIES.has(category)) return 'refund';
        return null;
    }
    if (provider === 'paypal') {
        const code = type.toUpperCase();
        if (gross > 0 && PAYPAL_PAYMENT_CODES.has(code)) return 'payment';
        if (gross < 0 && PAYPAL_REFUND_CODES.has(code)) return 'refund';
    }
    return null;
}

function historyRecord(row, kind) {
    const gross = Number(row.gross_amount_minor || 0);
    const provider = String(row.provider || '').toLowerCase();
    const customerId = row.customer_id ? String(row.customer_id) : null;
    const providerCustomerId = row.provider_customer_id ? String(row.provider_customer_id) : null;
    return {
        kind,
        minor: kind === 'refund' ? Math.abs(gross) : gross,
        currency: String(row.currency || 'USD').toUpperCase(),
        provider,
        eventType: String(row.transaction_type || ''),
        createdAt: new Date(row.occurred_at),
        providerEventId: String(row.provider_transaction_id || ''),
        payerKey: customerId ? `customer:${customerId}` : providerCustomerId ? `${provider}:${providerCustomerId}` : null,
        source: 'history'
    };
}

function eventRecords(row) {
    const records = [];
    const payment = revenueFromEvent(row);
    if (payment) {
        records.push({
            kind: 'payment',
            minor: Number(payment.minor || 0),
            currency: String(payment.currency || 'USD').toUpperCase(),
            provider: row.provider,
            eventType: row.event_type,
            createdAt: new Date(row.created_at),
            providerEventId: row.provider_event_id,
            payerKey: payment.email ? `email:${String(payment.email).trim().toLowerCase()}` : null,
            email: payment.email || null,
            source: 'event'
        });
    }
    const refund = refundFromEvent(row);
    if (refund) {
        records.push({
            kind: 'refund',
            minor: Number(refund.minor || 0),
            currency: String(refund.currency || 'USD').toUpperCase(),
            provider: row.provider,
            eventType: row.event_type,
            createdAt: new Date(row.created_at),
            providerEventId: row.provider_event_id,
            payerKey: null,
            source: 'event'
        });
    }
    return records;
}

async function accountingRecords(range) {
    const [runs, history, events] = await Promise.all([
        query(`SELECT provider_scope,range_start,range_end,completed_at FROM payment_history_import_runs WHERE status='completed' ORDER BY range_start`),
        query(`
            SELECT provider,provider_transaction_id,transaction_type,occurred_at,currency,gross_amount_minor,customer_id,provider_customer_id
            FROM payment_history_transactions
            WHERE occurred_at >= $1 AND occurred_at < $2
            ORDER BY occurred_at DESC
        `, [range.previousStart, range.end]),
        query(`
            SELECT provider,provider_event_id,event_type,payload,created_at
            FROM payment_events
            WHERE provider IN ('stripe','paypal')
              AND processed_at IS NOT NULL AND processing_error IS NULL
              AND created_at >= $1 AND created_at < $2
            ORDER BY created_at DESC
            LIMIT 25000
        `, [range.previousStart, range.end])
    ]);
    const coverage = coverageFromRuns(runs.rows);
    const records = [];
    for (const row of events.rows) {
        if (isCovered(coverage, row.provider, row.created_at)) continue;
        records.push(...eventRecords(row));
    }
    for (const row of history.rows) {
        if (!isCovered(coverage, row.provider, row.occurred_at)) continue;
        const kind = historyKind(row);
        if (kind) records.push(historyRecord(row, kind));
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    return { records, coverage };
}

function inWindow(at, start, end) {
    return at >= start && at < end;
}

async function revenueSummary(range, fallbackCurrency = 'USD') {
    const { records, coverage } = await accountingRecords(range);
    const current = records.filter(row => row.kind === 'payment' && inWindow(row.createdAt, range.start, range.end));
    const previous = records.filter(row => row.kind === 'payment' && inWindow(row.createdAt, range.previousStart, range.previousEnd));
    const byCurrency = new Map();
    for (const record of current) byCurrency.set(record.currency, (byCurrency.get(record.currency) || 0) + record.minor);
    const primaryCurrency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackCurrency || 'USD';
    const totalMinor = current.filter(row => row.currency === primaryCurrency).reduce((sum, row) => sum + row.minor, 0);
    const previousMinor = previous.filter(row => row.currency === primaryCurrency).reduce((sum, row) => sum + row.minor, 0);
    const buckets = fillSeries(range, [], []).map(point => ({ ...point, revenue_minor: 0 }));
    const byKey = new Map(buckets.map(point => [point.key, point]));
    for (const record of current) {
        if (record.currency !== primaryCurrency) continue;
        const point = byKey.get(bucketKey(record.createdAt, range.bucket));
        if (point) point.revenue_minor += record.minor;
    }
    return {
        primaryCurrency,
        totalMinor,
        previousMinor,
        currencies: [...byCurrency.entries()].map(([currency, minor]) => ({ currency, minor })),
        series: buckets,
        recent: current.slice(0, 12),
        coverage
    };
}

async function commerceRevenue(range, reporting, reportingCurrency) {
    const { records, coverage } = await accountingRecords(range);
    const target = reportingCurrency.cleanCurrency(reporting?.currency || 'GBP');
    const convert = record => reportingCurrency.convertMinor(Number(record.minor || 0), record.currency || target, target, reporting);
    let grossMinor = 0;
    let previousGrossMinor = 0;
    let refundMinor = 0;
    let previousRefundMinor = 0;
    let refundCount = 0;
    const payerKeys = new Set();
    const byBucketCurrency = new Map();
    for (const record of records) {
        const current = inWindow(record.createdAt, range.start, range.end);
        const previous = inWindow(record.createdAt, range.previousStart, range.previousEnd);
        if (!current && !previous) continue;
        const amount = convert(record);
        if (record.kind === 'payment') {
            if (current) {
                grossMinor += amount;
                if (record.payerKey) payerKeys.add(record.payerKey);
                const key = bucketKey(record.createdAt, range.bucket);
                if (!byBucketCurrency.has(key)) byBucketCurrency.set(key, new Map());
                const bucket = byBucketCurrency.get(key);
                bucket.set(target, (bucket.get(target) || 0) + amount);
            } else {
                previousGrossMinor += amount;
            }
        } else if (record.kind === 'refund') {
            if (current) {
                refundMinor += amount;
                refundCount += 1;
            } else {
                previousRefundMinor += amount;
            }
        }
    }
    return {
        primaryCurrency: target,
        grossMinor,
        previousGrossMinor,
        netMinor: grossMinor - refundMinor,
        previousNetMinor: previousGrossMinor - previousRefundMinor,
        refundMinor,
        refundCount,
        previousRefundMinor,
        payingCustomers: payerKeys.size,
        arpuMinor: payerKeys.size ? Math.round(grossMinor / payerKeys.size) : 0,
        currencies: [target],
        byBucketCurrency,
        coverage
    };
}

module.exports = {
    coverageFromRuns,
    isCovered,
    historyKind,
    accountingRecords,
    revenueSummary,
    commerceRevenue,
    refundFromEvent
};
