'use strict';

const { esc, layout } = require('./admin-html');
const { renderMain } = require('./admin-dashboard-main');
const { rangeControls } = require('./admin-dashboard-view');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const integrationCard = require('./admin-integration-card');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
}

// Page-chrome pieces specific to this dashboard's own layout (setup nudge +
// fixed Needs Attention summary above the customizable analytics grid) stay
// local rather than becoming another dashboard widget or health data source.
function setupCompact(s) {
    const setup = s.setup;
    if (!setup || setup.configuredCount >= setup.totalCount) return '';
    return `<div class="setupCompact"><div><strong>Platform setup is not complete</strong><br><span>${esc(setup.configuredCount)} / ${esc(setup.totalCount)} configured · finish the optional setup areas when you are ready.</span></div><a class="button secondary" href="/admin/setup">Open Setup</a></div>`;
}

function attentionOverview(s) {
    const attention = s.attention || { count: 0, items: [] };
    const items = Array.isArray(attention.items) ? attention.items : [];
    if (!Number(attention.count || 0)) {
        return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>Needs Attention</h2><p>Operational exceptions from the same source used by the full Needs Attention workspace.</p></div><span class="pill good">Clear</span></div><div class="attentionClear"><div><strong>No operational issues need attention</strong><br><span>Servers, payments, provisioning, notifications, backups, automation and Stremio sources have no unresolved Needs Attention items.</span></div><a class="button secondary btn-sm" href="/admin/attention">View Needs Attention</a></div></section>`;
    }
    const rows = items.map(item => `<a class="attentionItem" href="${esc(item.href || '/admin/attention')}"><span class="attentionSeverity ${item.severity === 'critical' ? 'critical' : ''}" aria-hidden="true"></span><span class="attentionItemText"><strong>${esc(item.title || 'Needs review')}</strong><span>${esc(item.detail || '')}</span></span><span class="attentionArea">${esc(item.area || '')}</span></a>`).join('');
    const more = Number(attention.count || 0) > items.length ? `<div class="attentionMore">Showing the ${items.length} highest-priority items. ${Number(attention.count) - items.length} more ${Number(attention.count) - items.length === 1 ? 'item' : 'items'} remain.</div>` : '';
    return `<section class="attentionOverview"><div class="attentionOverviewHead"><div><h2>${esc(attention.count)} ${Number(attention.count) === 1 ? 'thing needs' : 'things need'} attention</h2><p>Resolve customer-impacting and operational exceptions before routine analytics.</p></div><a class="button secondary btn-sm" href="/admin/attention">View all</a></div><div class="attentionItems">${rows}</div>${more}</section>`;
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
        const body = `${integrationCard.styles()}${messageBlock(req)}${attentionOverview(stats)}${setupCompact(stats)}${rangeControls(ctx.range)}${html}`;
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

module.exports = { dashboardPage, dashboardData, primaryAction, dashboardRange, attentionOverview };
