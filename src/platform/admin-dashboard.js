'use strict';

const { esc, layout } = require('./admin-html');
const { renderMain } = require('./admin-dashboard-main');
const { rangeControls } = require('./admin-dashboard-view');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const integrationCard = require('./admin-integration-card');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');
const ui = require('./admin-ui');
const { money, number } = require('./admin-dashboard-format');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
}

// Page-chrome pieces specific to this dashboard's own layout (setup nudge +
// fixed Needs Attention summary above the customizable analytics grid) stay
// local rather than becoming another dashboard widget or health data source.
function setupCompact(s) {
    const setup = s.setup;
    if (!setup || setup.configuredCount >= setup.totalCount) return '';
    return `<div class="setupCompact"><div><strong>Platform setup is not complete</strong><br><span>${esc(setup.configuredCount)} / ${esc(setup.totalCount)} configured · finish the optional setup areas when you are ready.</span></div><a class="button secondary" href="/admin/setup">Finish setup</a></div>`;
}

function attentionActionLabel(item) {
    if (item?.actionLabel) return String(item.actionLabel);
    const key = String(item?.key || '');
    if (key.startsWith('backup:')) return 'Open backup recovery';
    if (key.startsWith('server:')) return 'Open server recovery';
    if (key.startsWith('job:') || key.startsWith('worker:')) return 'Open automation';
    if (key.startsWith('payment:')) return 'Review payment case';
    if (key.startsWith('notification:')) return 'Open delivery failures';
    if (key.startsWith('provisioning:')) return 'Review access retry';
    if (key.startsWith('stremio-')) return 'Reconnect source';
    return 'Review issue';
}

function attentionOverview(s) {
    const attention = s.attention || { count: 0, items: [] };
    const items = Array.isArray(attention.items) ? attention.items : [];
    if (!Number(attention.count || 0)) {
        return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>Needs Attention</h2><p>Only current problems that require human judgement or intervention appear here.</p></div><span class="pill good">All clear</span></div><div class="attentionClear"><div><strong>No intervention is required</strong><br><span>Transient timeouts, automatic retries and recovered failures remain in diagnostics/history instead of interrupting you.</span></div><a class="button secondary btn-sm" href="/admin/attention">Open operational inbox</a></div></section>`;
    }
    const rows = items.map(item => `<a class="attentionItem ${item.severity === 'critical' ? 'critical' : ''}" href="${esc(item.href || '/admin/attention')}"><span class="attentionSeverity ${item.severity === 'critical' ? 'critical' : ''}" aria-hidden="true"></span><span class="attentionItemText"><strong>${esc(item.title || 'Needs review')}</strong><span>${esc(item.detail || '')}</span></span><span class="attentionArea">${esc(item.area || '')}</span><span class="attentionItemAction">${esc(attentionActionLabel(item))} →</span></a>`).join('');
    const more = Number(attention.count || 0) > items.length ? `<div class="attentionMore">Showing the ${items.length} highest-priority items. ${Number(attention.count) - items.length} more ${Number(attention.count) - items.length === 1 ? 'item' : 'items'} remain.</div>` : '';
    return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>${esc(attention.count)} ${Number(attention.count) === 1 ? 'problem needs' : 'problems need'} intervention</h2><p>These conditions have outlasted normal automatic recovery or require a decision automation cannot make.</p></div><a class="button secondary btn-sm" href="/admin/attention">Open issues</a></div><div class="attentionItems">${rows}</div>${more}</section>`;
}

function dashboardHero(ctx) {
    const stats = ctx.data || {};
    const attention = stats.attention || { count: 0, items: [] };
    const count = Number(attention.count || 0);
    const items = Array.isArray(attention.items) ? attention.items : [];
    const hasCritical = items.some(item => item.severity === 'critical');
    const setupIncomplete = stats.setup && stats.setup.configuredCount < stats.setup.totalCount;
    const tone = count ? (hasCritical ? 'bad' : 'warn') : setupIncomplete ? 'info' : 'good';
    const next = count
        ? `Review ${count} current ${count === 1 ? 'issue' : 'issues'} that automatic recovery could not clear.`
        : setupIncomplete ? 'Finish setup when convenient; no live operational issue is blocking you.' : 'No intervention is required. Review performance or continue normal admin work.';
    const actions = count
        ? `<a class="button" href="/admin/attention">Review ${count} ${count === 1 ? 'issue' : 'issues'}</a><a class="button secondary" href="/admin/users/new">Add customer</a>`
        : `<a class="button" href="/admin/users/new">Add customer</a><a class="button secondary" href="/admin/plans">Manage plans</a>`;
    return ui.operatorHero({
        tone,
        eyebrow: 'Operator control room',
        title: count ? `${count} ${count === 1 ? 'current issue needs' : 'current issues need'} your attention` : 'CAPTAiNFiN is operating normally',
        body: count ? 'Only persistent, unresolved or judgement-required exceptions are shown below. Routine retry noise is suppressed.' : 'The important operating signals are healthy. Use the dashboard for business and streaming performance.',
        statusLabel: hasCritical ? 'Action required' : count ? 'Review recommended' : setupIncomplete ? 'Healthy · setup incomplete' : 'Healthy',
        next,
        facts: [
            { label: 'Needs intervention', value: number(count), detail: count ? 'persistent current exceptions' : 'nothing requiring human action' },
            { label: 'Active customers', value: number(stats.current?.activeCustomers || 0), detail: 'effective access now' },
            { label: 'Live streams', value: number(stats.current?.fleetStreams || 0), detail: 'fleet-wide playback now' },
            { label: 'MRR', value: money(stats.mrr?.amountMinor || 0, stats.mrr?.currency || ctx.reporting?.currency || 'GBP'), detail: 'verified recurring billing' }
        ],
        actionsHtml: actions
    });
}

function primaryAction(stats) {
    if (!stats.setup?.counts?.plans) return '<a class="button" href="/admin/plans">+ Create plan</a>';
    if (!stats.setup?.counts?.servers) return '<a class="button" href="/admin/servers/new">+ Add server</a>';
    return '<a class="button" href="/admin/users/new">+ Add customer</a>';
}

function messageBlock(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}

async function dashboardPage(req, res) {
    if (!isNativeAdmin(req)) return res.redirect('/login?session=expired');
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    try {
        await Promise.all([runtimeSettings.ensureLoaded(),reportingCurrency.refreshRates().catch(()=>null)]);
        const { ctx, html } = await renderMain(req);
        const stats = ctx.data;
        const body = `${integrationCard.styles()}${messageBlock(req)}${dashboardHero(ctx)}${attentionOverview(stats)}${setupCompact(stats)}${rangeControls(ctx.range)}${html}`;
        return res.send(layout({
            siteName: runtimeSettings.siteName(),
            active: 'dashboard',
            title: 'Admin Dashboard',
            subtitle: `Human intervention first, then business and streaming performance · ${ctx.range.label} · ${ctx.reporting.currency}`,
            body,
            action: primaryAction(stats)
        }));
    } catch (error) {
        console.error('Admin dashboard failed:', error.message);
        return res.status(500).render('auth/message', {
            siteName: runtimeSettings.siteName(),
            title: 'Dashboard unavailable',
            message: 'The administration dashboard could not be loaded safely.',
            link: '/admin/setup',
            linkText: 'Open Setup'
        });
    }
}

module.exports = { dashboardPage, dashboardData, primaryAction, dashboardRange, attentionOverview, attentionActionLabel, dashboardHero };
