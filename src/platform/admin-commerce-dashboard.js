'use strict';

const { query } = require('../db');
const incidents = require('../payments/incidents');
const { dashboardRange, fillSeries, revenueFromEvent } = require('./admin-dashboard-analytics');
const { mrrByCurrency, primaryMrr, revenueMixByService, revenueByPlan, revenueByBillingInterval } = require('./admin-dashboard-main');
const registry = require('./admin-dashboard-registry');
const widgets = require('./admin-dashboard-widgets');
const { number, money } = require('./admin-dashboard-format');
const { esc } = require('./admin-html');

// Refunds are not covered by revenueFromEvent() (which only recognizes
// completed-payment event types), so they get their own small parser here,
// reusing the same provider payload shapes.
function refundFromEvent(row) {
    const payload = row.payload || {};
    if (row.provider === 'stripe' && row.event_type === 'charge.refunded') {
        const object = payload?.data?.object;
        const amount = Number(object?.amount_refunded);
        if (!object || !Number.isFinite(amount) || amount <= 0) return null;
        return { minor: amount, currency: String(object.currency || 'USD').toUpperCase() };
    }
    if (row.provider === 'paypal' && row.event_type === 'PAYMENT.SALE.REFUNDED') {
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

async function paymentEventsInRange(range) {
    const result = await query(`
        SELECT provider,provider_event_id,event_type,payload,created_at
        FROM payment_events
        WHERE provider IN ('stripe','paypal')
          AND processed_at IS NOT NULL AND processing_error IS NULL
          AND created_at >= $1 AND created_at < $2
        ORDER BY created_at DESC
        LIMIT 25000
    `, [range.previousStart, range.end]);
    return result.rows;
}

// One pass over the shared event set: gross revenue (current + previous
// period, for the delta badge), distinct paying-customer emails, and refund
// totals -- all scoped to the same primary currency so they stay comparable.
function summarizeEvents(events, range, fallbackCurrency) {
    const byCurrency = new Map();
    for (const row of events) {
        const at = new Date(row.created_at);
        if (at < range.start || at >= range.end) continue;
        const payment = revenueFromEvent(row);
        if (!payment) continue;
        byCurrency.set(payment.currency, (byCurrency.get(payment.currency) || 0) + payment.minor);
    }
    const primaryCurrency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackCurrency || 'USD';
    const grossMinor = byCurrency.get(primaryCurrency) || 0;

    let previousGrossMinor = 0, refundMinor = 0, refundCount = 0, previousRefundMinor = 0;
    const payingEmails = new Set();
    const byBucketCurrency = new Map();
    for (const row of events) {
        const at = new Date(row.created_at);
        const inCurrent = at >= range.start && at < range.end;
        const inPrevious = at >= range.previousStart && at < range.previousEnd;
        if (!inCurrent && !inPrevious) continue;
        const payment = revenueFromEvent(row);
        if (payment) {
            if (inCurrent) {
                if (payment.email) payingEmails.add(payment.email.toLowerCase());
                const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
                const d = new Date(at);
                const bucketDate = bucket === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) : d;
                const key = bucketDate.toISOString().slice(0, bucket === 'month' ? 7 : 10);
                if (!byBucketCurrency.has(key)) byBucketCurrency.set(key, new Map());
                const m = byBucketCurrency.get(key);
                m.set(payment.currency, (m.get(payment.currency) || 0) + payment.minor);
            } else if (payment.currency === primaryCurrency) {
                previousGrossMinor += payment.minor;
            }
        }
        const refund = refundFromEvent(row);
        if (refund && refund.currency === primaryCurrency) {
            if (inCurrent) { refundMinor += refund.minor; refundCount++; }
            else previousRefundMinor += refund.minor;
        }
    }
    return {
        primaryCurrency, grossMinor, previousGrossMinor,
        netMinor: grossMinor - refundMinor, previousNetMinor: previousGrossMinor - previousRefundMinor,
        refundMinor, refundCount, previousRefundMinor,
        payingCustomers: payingEmails.size,
        arpuMinor: payingEmails.size ? Math.round(grossMinor / payingEmails.size) : 0,
        currencies: [...byCurrency.keys()],
        byBucketCurrency
    };
}

async function refundAndFailureSeries(range) {
    const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
    const [refunds, failures] = await Promise.all([
        query(`SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int n FROM payment_events WHERE event_type IN('charge.refunded','PAYMENT.SALE.REFUNDED') AND created_at>=$1 AND created_at<$2 GROUP BY 1`, [range.start, range.end]),
        query(`SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int n FROM payment_events WHERE processing_error IS NOT NULL AND created_at>=$1 AND created_at<$2 GROUP BY 1`, [range.start, range.end])
    ]);
    const r = fillSeries(range, refunds.rows, ['n']);
    const f = fillSeries(range, failures.rows, ['n']);
    return r.map((row, i) => ({ label: row.label, key: row.key, refunds: row.n, failed: f[i]?.n || 0 }));
}

async function renewalVsChurn(range) {
    const result = await query(`
        SELECT
          COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND created_at>=$1 AND created_at<$2)::int activations,
          COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND status IN('cancelled','expired') AND updated_at>=$1 AND updated_at<$2)::int churn
        FROM subscriptions
    `, [range.start, range.end]);
    return result.rows[0] || { activations: 0, churn: 0 };
}

async function checkoutFunnel(range) {
    const result = await query(`
        SELECT COUNT(*)::int created,COUNT(*) FILTER(WHERE state='completed')::int completed
        FROM billing_checkout_intents WHERE created_at>=$1 AND created_at<$2
    `, [range.start, range.end]);
    const row = result.rows[0] || { created: 0, completed: 0 };
    return [
        { label: 'Checkout started', count: Number(row.created || 0) },
        { label: 'Checkout completed', count: Number(row.completed || 0) }
    ];
}

async function topPlansBySubscribers(limit = 10) {
    const result = await query(`
        SELECT p.name,p.service_type,p.billing_interval,COUNT(*)::int subscribers
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.status IN('active','trialing') AND s.current_period_end>NOW()
        GROUP BY p.id,p.name,p.service_type,p.billing_interval ORDER BY subscribers DESC LIMIT $1
    `, [limit]);
    return result.rows;
}

async function paymentStateBreakdown() {
    const rows = await incidents.recent(100);
    let open = 0, acknowledged = 0, resolved = 0;
    for (const row of rows) {
        if (row.resolved_at) resolved++;
        else if (row.acknowledged_at) acknowledged++;
        else open++;
    }
    return { open, acknowledged, resolved, total: rows.length };
}

async function buildContext(req) {
    const range = dashboardRange(req.query || {});
    const [mrrRows, previousMrrRows, events, refundFailureSeries, renewal, funnel, topPlans, paymentStates] = await Promise.all([
        mrrByCurrency(range.end),
        mrrByCurrency(range.previousEnd),
        paymentEventsInRange(range),
        refundAndFailureSeries(range),
        renewalVsChurn(range),
        checkoutFunnel(range),
        topPlansBySubscribers(10),
        paymentStateBreakdown()
    ]);
    const mrr = primaryMrr(mrrRows);
    const previousMrr = primaryMrr(previousMrrRows, mrr.currency);
    const revenue = summarizeEvents(events, range, mrr.currency);
    const [revenueMix, billingInterval, planRevenue] = await Promise.all([
        revenueMixByService(revenue.primaryCurrency),
        revenueByBillingInterval(revenue.primaryCurrency),
        revenueByPlan(revenue.primaryCurrency)
    ]);
    return { range, data: { mrr, previousMrr, revenue, refundFailureSeries, renewal, funnel, topPlans, paymentStates, revenueMix, billingInterval, planRevenue } };
}
registry.registerContextBuilder('commerce', buildContext);

function mrrDelta(current, previous) {
    if (!previous) return current ? null : 0;
    return ((current - previous) / previous) * 100;
}

registry.register('commerce', 'mrr', {
    title: 'Monthly recurring revenue', subtitle: 'Same calculation as the Main dashboard.', defaultOrder: 1, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'commerceMrr', label: 'MRR', value: money(ctx.data.mrr.amountMinor, ctx.data.mrr.currency), meta: `${number(ctx.data.mrr.subscriptions)} recurring subscription(s)`, delta: mrrDelta(ctx.data.mrr.amountMinor, ctx.data.previousMrr.amountMinor) })
});
registry.register('commerce', 'grossRevenue', {
    title: 'Gross revenue', subtitle: 'Successful provider payments in the selected period.', defaultOrder: 2, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'grossRevenue', label: 'Gross revenue', value: money(ctx.data.revenue.grossMinor, ctx.data.revenue.primaryCurrency), delta: mrrDelta(ctx.data.revenue.grossMinor, ctx.data.revenue.previousGrossMinor), href: '/admin/payments' })
});
registry.register('commerce', 'netRevenue', {
    title: 'Net revenue', subtitle: 'Gross revenue minus refunds in the selected period.', defaultOrder: 3, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'netRevenue', label: 'Net revenue', value: money(ctx.data.revenue.netMinor, ctx.data.revenue.primaryCurrency), meta: ctx.data.revenue.refundCount ? `${money(ctx.data.revenue.refundMinor, ctx.data.revenue.primaryCurrency)} refunded (${number(ctx.data.revenue.refundCount)})` : 'No refunds this period', delta: mrrDelta(ctx.data.revenue.netMinor, ctx.data.revenue.previousNetMinor) })
});
registry.register('commerce', 'payingCustomersArpu', {
    title: 'Paying customers & ARPU', subtitle: 'Deduplicated by payment email, not internal customer ID -- a customer paying with two different emails counts twice.', defaultOrder: 4, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'arpu', label: 'ARPU', value: money(ctx.data.revenue.arpuMinor, ctx.data.revenue.primaryCurrency), meta: `${number(ctx.data.revenue.payingCustomers)} paying customer(s) this period` })
});
registry.register('commerce', 'renewalVsChurn', {
    title: 'Activations vs churn', subtitle: 'New paid/free-service activations against cancelled or expired subscriptions in the selected period.', defaultOrder: 5, defaultSpan: 6,
    render: async ctx => widgets.barChart([{ label: 'Activations', count: ctx.data.renewal.activations }, { label: 'Churn', count: ctx.data.renewal.churn }], 'count', undefined, { orientation: 'horizontal' })
});
registry.register('commerce', 'revenueOverTime', {
    title: 'Revenue over time', subtitle: 'Stacked by currency when more than one is present.', defaultOrder: 6, defaultSpan: 6,
    render: async ctx => {
        const currencies = ctx.data.revenue.currencies.slice(0, 4);
        if (!currencies.length) return widgets.emptyState('No provider payments recorded in this period.');
        const buckets = fillSeries(ctx.range, [], []);
        const rows = buckets.map(point => {
            const bucketMap = ctx.data.revenue.byBucketCurrency.get(point.key) || new Map();
            const out = { label: point.label, key: point.key };
            for (const currency of currencies) out[currency] = bucketMap.get(currency) || 0;
            return out;
        });
        return widgets.stackedAreaChart(rows, currencies, value => money(value, currencies[0]));
    }
});
registry.register('commerce', 'mrrComposition', {
    title: 'MRR composition', subtitle: 'Monthly-equivalent recurring revenue by delivery type.', defaultOrder: 7, defaultSpan: 4,
    render: async ctx => ctx.data.revenueMix.length ? widgets.donutChart(ctx.data.revenueMix, { formatter: value => money(value, ctx.data.revenue.primaryCurrency) }) : widgets.emptyState('No recurring revenue to break down yet.')
});
registry.register('commerce', 'revenueByInterval', {
    title: 'Revenue by billing interval', defaultOrder: 8, defaultSpan: 4,
    render: async ctx => ctx.data.billingInterval.length ? widgets.donutChart(ctx.data.billingInterval, { formatter: value => money(value, ctx.data.revenue.primaryCurrency) }) : widgets.emptyState('No recurring revenue to break down yet.')
});
registry.register('commerce', 'planPerformance', {
    title: 'Plan performance', subtitle: 'Monthly-equivalent recurring revenue contribution by plan.', defaultOrder: 9, defaultSpan: 4,
    render: async ctx => ctx.data.planRevenue.length ? widgets.barChart(ctx.data.planRevenue.map(row => ({ label: row.name, count: Number(row.amount_minor || 0) })), 'count', value => money(value, ctx.data.revenue.primaryCurrency), { orientation: 'horizontal' }) : widgets.emptyState('No recurring plans generating revenue yet.')
});
registry.register('commerce', 'paymentStateBreakdown', {
    title: 'Payment incident states', subtitle: 'Provider verification and access-recovery workflow items.', defaultOrder: 10, defaultSpan: 6, lazy: true,
    render: async ctx => {
        const s = ctx.data.paymentStates;
        if (!s.total) return widgets.emptyState('No customer payment incidents recorded yet.');
        return widgets.donutChart([{ name: 'New', count: s.open }, { name: 'Acknowledged', count: s.acknowledged }, { name: 'Resolved', count: s.resolved }]);
    }
});
registry.register('commerce', 'checkoutFunnel', {
    title: 'Checkout funnel', subtitle: 'CAPTAiNFiN does not track pre-checkout visitors, so this funnel starts at checkout creation.', defaultOrder: 11, defaultSpan: 6,
    render: async ctx => widgets.funnelChart(ctx.data.funnel)
});
registry.register('commerce', 'refundFailedTrend', {
    title: 'Refunds & failed payments', defaultOrder: 12, defaultSpan: 8, lazy: true,
    render: async ctx => ctx.data.refundFailureSeries.some(row => row.refunds || row.failed) ? widgets.stackedAreaChart(ctx.data.refundFailureSeries, ['refunds', 'failed']) : widgets.emptyState('No refunds or failed payment events in this period.')
});
registry.register('commerce', 'topPlans', {
    title: 'Top plans by subscribers', defaultOrder: 13, defaultSpan: 4, lazy: true,
    render: async ctx => {
        if (!ctx.data.topPlans.length) return widgets.emptyState('No active plans have subscribers yet.');
        return widgets.statusTable(ctx.data.topPlans, [
            { key: 'name', label: 'Plan', render: row => esc(row.name) },
            { key: 'service_type', label: 'Service', render: row => esc(row.service_type) },
            { key: 'subscribers', label: 'Subscribers', align: 'numeric', render: row => esc(row.subscribers) }
        ]);
    }
});

module.exports = { buildContext, refundFromEvent };
