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
    const key = String(item?.key || '');
    if (key.startsWith('backup:')) return 'Fix backup';
    if (key.startsWith('server:')) return 'Fix server';
    if (key.startsWith('job:') || key.startsWith('worker:')) return 'Fix automation';
    if (key.startsWith('payment:')) return 'Resolve payment';
    if (key.startsWith('notification:')) return 'Fix notification';
    if (key.startsWith('provisioning:')) return 'Fix provisioning';
    if (key.startsWith('stremio-')) return 'Fix source';
    if (key.startsWith('activation:')) return 'Help customer';
    return 'Resolve';
}

function attentionOverview(s) {
    const attention = s.attention || { count: 0, items: [] };
    const items = Array.isArray(attention.items) ? attention.items : [];
    if (!Number(attention.count || 0)) {
        return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>Needs Attention</h2><p>Only exceptions that require operator judgement or action appear here.</p></div><span class="pill good">All clear</span></div><div class="attentionClear"><div><strong>No operational issues need attention</strong><br><span>Routine analytics and administration can continue normally.</span></div><a class="button secondary btn-sm" href="/admin/attention">Open operational inbox</a></div></section>`;
    }
    const rows = items.map(item => `<a class="attentionItem ${item.severity === 'critical' ? 'critical' : ''}" href="${esc(item.href || '/admin/attention')}"><span class="attentionSeverity ${item.severity === 'critical' ? 'critical' : ''}" aria-hidden="true"></span><span class="attentionItemText"><strong>${esc(item.title || 'Needs review')}</strong><span>${esc(item.detail || '')}</span></span><span class="attentionArea">${esc(item.area || '')}</span><span class="attentionItemAction">${esc(attentionActionLabel(item))} →</span></a>`).join('');
    const more = Number(attention.count || 0) > items.length ? `<div class="attentionMore">Showing the ${items.length} highest-priority items. ${Number(attention.count) - items.length} more ${Number(attention.count) - items.length === 1 ? 'item' : 'items'} remain.</div>` : '';
    return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>${esc(attention.count)} ${Number(attention.count) === 1 ? 'thing needs' : 'things need'} attention</h2><p>Each item should take you to the exact place and action required to resolve it.</p></div><a class="button secondary btn-sm" href="/admin/attention">Resolve all</a></div><div class="attentionItems">${rows}</div>${more}</section>`;
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
        ? `Resolve ${count} operational ${count === 1 ? 'issue' : 'issues'} before routine work.`
        : setupIncomplete ? 'Finish setup when convenient; no live operational issue is blocking you.' : 'No intervention is required. Review performance or continue normal admin work.';
    const actions = count
        ? `<a class="button" href="/admin/attention">Resolve ${count} ${count === 1 ? 'issue' : 'issues'}</a><a class="button secondary" href="/admin/users/new">Add customer</a>`
        : `<a class="button" href="/admin/users/new">Add customer</a><a class="button secondary" href="/admin/plans">Manage plans</a>`;
    return ui.operatorHero({
        tone,
        eyebrow: 'Operator control room',
        title: count ? `${count} ${count === 1 ? 'item needs' : 'items need'} your attention` : 'CAPTAiNFiN is operating normally',
        body: count ? 'Start with the exceptions below. Routine analytics come afterwards.' : 'The important operating signals are healthy. Use the dashboard for business and streaming performance.',
        statusLabel: hasCritical ? 'Action required' : count ? 'Review needed' : setupIncomplete ? 'Healthy · setup incomplete' : 'Healthy',
        next,
        facts: [
            { label: 'Needs attention', value: number(count), detail: count ? 'open operational exceptions' : 'nothing blocking normal work' },
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
            subtitle: `What needs attention first, then business and streaming performance · ${ctx.range.label} · ${ctx.reporting.currency}`,
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
