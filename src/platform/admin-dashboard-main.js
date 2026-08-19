'use strict';

const { query } = require('../db');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange, fillSeries } = require('./admin-dashboard-analytics');
const reportingCurrency = require('./reporting-currency');
const registry = require('./admin-dashboard-registry');
const widgets = require('./admin-dashboard-widgets');
const { renderWidgetGrid } = require('./admin-dashboard-page');
const { esc } = require('./admin-html');
const { number, money } = require('./admin-dashboard-format');

// Recurring-revenue subscriptions only: active/trialing with a verified
// provider-billed identity (mirrors the filter admin-commerce.js already uses
// for its MRR figure, so Main and Commerce report the same number).
const MRR_FILTER = `s.superseded_by IS NULL AND s.status IN('active','trialing') AND s.starts_at<=$1 AND s.current_period_end>$1
      AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))`;
const MONTHLY_EQUIVALENT = `ROUND(COALESCE(s.price_minor_snapshot,p.price_minor)::numeric * CASE COALESCE(s.billing_interval_snapshot,p.billing_interval)
        WHEN 'month' THEN 1 WHEN '6_months' THEN 1.0/6 WHEN 'year' THEN 1.0/12
        ELSE 30.4375/GREATEST(COALESCE(s.duration_days_snapshot,p.duration_days,30),1) END)`;

async function mrrByCurrency(asOf = new Date()) {
    const result = await query(`
        SELECT COALESCE(s.currency_snapshot,p.currency) currency,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${MRR_FILTER}
        GROUP BY 1 ORDER BY 2 DESC
    `, [asOf]);
    return result.rows;
}

function primaryMrr(rows, fallbackCurrency = 'USD') {
    const top = rows[0];
    return { currency: top?.currency || fallbackCurrency, amountMinor: Number(top?.amount_minor || 0), subscriptions: rows.reduce((sum, r) => sum + Number(r.subscriptions || 0), 0) };
}

async function churnRate(range) {
    const [cancelled, activeAtStart] = await Promise.all([
        query(`SELECT COUNT(*)::int n FROM subscriptions WHERE status='cancelled' AND updated_at>=$1 AND updated_at<$2`, [range.start, range.end]),
        query(`SELECT COUNT(*)::int n FROM subscriptions WHERE status IN('active','trialing','past_due','paused') AND starts_at<$1 AND current_period_end>$1`, [range.start])
    ]);
    const activeStart = Number(activeAtStart.rows[0]?.n || 0);
    const cancelledCount = Number(cancelled.rows[0]?.n || 0);
    return { cancelledCount, activeAtStart: activeStart, rate: activeStart ? (cancelledCount / activeStart * 100) : null };
}

async function newVsCancelledSeries(range) {
    const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
    const [newRows, cancelledRows] = await Promise.all([
        query(`SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int n FROM subscriptions WHERE created_at>=$1 AND created_at<$2 GROUP BY 1 ORDER BY 1`, [range.start, range.end]),
        query(`SELECT date_trunc('${bucket}',updated_at) bucket,COUNT(*)::int n FROM subscriptions WHERE status='cancelled' AND updated_at>=$1 AND updated_at<$2 GROUP BY 1 ORDER BY 1`, [range.start, range.end])
    ]);
    const newSeries = fillSeries(range, newRows.rows, ['n']);
    const cancelledSeries = fillSeries(range, cancelledRows.rows, ['n']);
    return newSeries.map((row, index) => ({ label: row.label, key: row.key, new: row.n, cancelled: cancelledSeries[index]?.n || 0 }));
}

async function revenueMixByService(currency) {
    const result = await query(`
        SELECT COALESCE(s.service_type_snapshot,p.service_type) name,SUM(${MONTHLY_EQUIVALENT})::bigint count
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${MRR_FILTER} AND COALESCE(s.currency_snapshot,p.currency)=$2
        GROUP BY 1 ORDER BY 2 DESC
    `, [new Date(), currency]);
    return result.rows;
}

async function revenueByPlan(currency, asOf = new Date()) {
    const result = await query(`
        SELECT p.name,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${MRR_FILTER} AND COALESCE(s.currency_snapshot,p.currency)=$2
        GROUP BY p.id,p.name ORDER BY amount_minor DESC
    `, [asOf, currency]);
    return result.rows;
}

async function revenueByBillingInterval(currency, asOf = new Date()) {
    const result = await query(`
        SELECT COALESCE(s.billing_interval_snapshot,p.billing_interval) name,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE ${MRR_FILTER} AND COALESCE(s.currency_snapshot,p.currency)=$2
        GROUP BY 1 ORDER BY amount_minor DESC
    `, [asOf, currency]);
    return result.rows;
}

async function recentCustomers(limit = 8) {
    const result = await query(`SELECT id,display_name,email,created_at FROM customers ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows;
}

async function buildContext(req) {
    const range = dashboardRange(req.query || {});
    const reporting = await reportingCurrency.getForUser(req.session.authUserId);
    const data = await dashboardData(range, reporting);
    const fallbackCurrency = data.revenue?.primaryCurrency || reporting.currency || 'USD';
    const [mrrRows, previousMrrRows, churn, newVsCancelled, revenueMix, recent] = await Promise.all([
        mrrByCurrency(range.end),
        mrrByCurrency(range.previousEnd),
        churnRate(range),
        newVsCancelledSeries(range),
        revenueMixByService(fallbackCurrency),
        recentCustomers(8)
    ]);
    const mrr = primaryMrr(mrrRows, fallbackCurrency);
    const previousMrr = primaryMrr(previousMrrRows, fallbackCurrency);
    return { range, reporting, data: { ...data, mrr, previousMrr, churn, newVsCancelled, revenueMix, recentCustomers: recent } };
}
registry.registerContextBuilder('main', buildContext);

function mrrDelta(current, previous) {
    if (!previous) return current ? null : 0;
    return ((current - previous) / previous) * 100;
}

registry.register('main', 'mrr', {
    title: 'Monthly recurring revenue', subtitle: 'Active/trialing subscriptions with a verified provider billing identity, normalized to a monthly equivalent.',
    defaultOrder: 1, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({
        key: 'mrr', label: 'MRR', value: money(ctx.data.mrr.amountMinor, ctx.data.mrr.currency),
        meta: `${number(ctx.data.mrr.subscriptions)} recurring subscription(s)`,
        delta: mrrDelta(ctx.data.mrr.amountMinor, ctx.data.previousMrr.amountMinor), href: '/admin/commerce'
    })
});
registry.register('main', 'activeCustomers', {
    title: 'Active customers', defaultOrder: 2, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'activeCustomers', label: 'Active customers', value: number(ctx.data.current.customers), meta: `${number(ctx.data.period.newCustomers)} new this period`, delta: ctx.data.period.delta.newCustomers, href: '/admin/users/dashboard' })
});
registry.register('main', 'liveStreams', {
    title: 'Live streams', subtitle: 'Current fleet-wide concurrent playback sessions.', defaultOrder: 3, defaultSpan: 3,
    render: async ctx => widgets.kpiCard({ key: 'liveStreams', label: 'Live streams', value: number(ctx.data.current.fleetStreams), meta: `${number(ctx.data.current.managedStreams)} managed`, href: '/admin/servers/dashboard' })
});
registry.register('main', 'churnRate', {
    title: 'Churn rate', subtitle: 'Subscriptions cancelled this period ÷ subscriptions active at the start of the period.', defaultOrder: 4, defaultSpan: 3,
    render: async ctx => {
        const rate = ctx.data.churn.rate;
        return widgets.kpiCard({ key: 'churnRate', label: 'Churn rate', value: rate == null ? '—' : `${number(rate, 1)}%`, meta: rate == null ? 'no active subscriptions at period start' : `${number(ctx.data.churn.cancelledCount)} cancelled of ${number(ctx.data.churn.activeAtStart)}`, href: '/admin/commerce' });
    }
});
registry.register('main', 'revenueTrend', {
    title: 'Revenue trend', subtitle: 'Successful provider payments.', defaultOrder: 5, defaultSpan: 8,
    render: async ctx => widgets.barChart(ctx.data.revenue.series, 'revenue_minor', value => money(value, ctx.data.revenue.primaryCurrency))
});
registry.register('main', 'revenueMix', {
    title: 'Revenue mix', subtitle: 'Monthly-equivalent recurring revenue by delivery type.', defaultOrder: 6, defaultSpan: 4,
    render: async ctx => widgets.donutChart(ctx.data.revenueMix, { formatter: value => money(value, ctx.data.revenue.primaryCurrency) })
});
registry.register('main', 'customerGrowth', {
    title: 'Customer base over time', subtitle: 'Cumulative CAPTAiNFiN customer accounts.', defaultOrder: 7, defaultSpan: 6,
    render: async ctx => widgets.areaChart(ctx.data.customerGrowth, 'total')
});
registry.register('main', 'newVsCancelled', {
    title: 'New vs cancelled subscriptions', defaultOrder: 8, defaultSpan: 6,
    render: async ctx => widgets.stackedAreaChart(ctx.data.newVsCancelled, ['new', 'cancelled'])
});
registry.register('main', 'planDistribution', {
    title: 'Plan distribution', subtitle: 'Active and trialing subscriptions by plan.', defaultOrder: 9, defaultSpan: 6,
    render: async ctx => widgets.barChart(ctx.data.planMix.map(row => ({ label: row.name, count: row.count })), 'count', undefined, { orientation: 'horizontal' })
});
registry.register('main', 'platformHealth', {
    title: 'Platform health', defaultOrder: 10, defaultSpan: 6,
    render: async ctx => {
        const o = ctx.data.operational || {};
        return widgets.healthWidget([
            { label: 'Offline servers', status: Number(o.offline_servers) ? 'bad' : 'good', detail: `${number(o.offline_servers)} offline`, href: '/admin/servers' },
            { label: 'Provisioning problems', status: Number(o.provisioning_problems) ? 'warn' : 'good', detail: `${number(o.provisioning_problems)} affected`, href: '/admin/provisioning' },
            { label: 'Payment errors (24h)', status: Number(o.payment_errors_24h) ? 'warn' : 'good', detail: `${number(o.payment_errors_24h)} error(s)`, href: '/admin/payments' },
            { label: 'Request sync problems', status: Number(o.request_sync_problems) ? 'warn' : 'good', detail: `${number(o.request_sync_problems)} affected`, href: '/admin/request-users' }
        ]);
    }
});
registry.register('main', 'upcomingRenewals', {
    title: 'Revenue future', defaultOrder: 11, defaultSpan: 6, lazy: true,
    render: async ctx => {
        const subtitle = `Expected automatic renewals in the next ${ctx.data.forecastDays} day${ctx.data.forecastDays === 1 ? '' : 's'}`;
        if (!ctx.data.renewals.length) return `<p class="analyticsFootnote">${subtitle}</p>${widgets.emptyState('No automatic renewals are due in this forecast window.')}`;
        return `<p class="analyticsFootnote">${subtitle}</p>${widgets.statusTable(ctx.data.renewals, [
            { key: 'current_period_end', label: 'Renewal', render: row => `<strong>${esc(new Date(row.current_period_end).toLocaleDateString('en-GB'))}</strong>` },
            { key: 'name', label: 'Customer', render: row => `<a href="/admin/users/${esc(row.customer_id)}">${esc(row.name)}</a>` },
            { key: 'price_minor', label: 'Amount', align: 'numeric', render: row => esc(money(row.price_minor, row.currency)) }
        ])}`;
    }
});
registry.register('main', 'recentActivity', {
    title: 'Recent activity', subtitle: 'Recent payments and newly registered customers.', defaultOrder: 12, defaultSpan: 6, lazy: true,
    render: async ctx => {
        const payments = (ctx.data.revenue.recent || []).slice(0, 6).map(row => ({ type: 'payment', at: row.createdAt, label: `${row.provider === 'stripe' ? 'Stripe' : 'PayPal'} payment`, meta: money(row.minor, row.currency), href: '/admin/payments' }));
        const customers = (ctx.data.recentCustomers || []).slice(0, 6).map(row => ({ type: 'customer', at: row.created_at, label: `New customer: ${row.display_name || row.email || 'Customer'}`, meta: '', href: `/admin/users/${row.id}` }));
        const merged = [...payments, ...customers].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);
        if (!merged.length) return widgets.emptyState('No recent activity in this period.');
        return widgets.statusTable(merged, [
            { key: 'label', label: 'Event', render: row => `<a href="${esc(row.href)}">${esc(row.label)}</a>` },
            { key: 'meta', label: 'Detail', render: row => esc(row.meta) },
            { key: 'at', label: 'When', render: row => esc(new Date(row.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })) }
        ]);
    }
});

async function renderMain(req) {
    const ctx = await buildContext(req);
    const html = await renderWidgetGrid('main', req, ctx);
    return { ctx, html };
}

module.exports = { renderMain, buildContext, mrrByCurrency, primaryMrr, churnRate, revenueMixByService, revenueByPlan, revenueByBillingInterval };
