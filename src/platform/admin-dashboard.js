'use strict';

const { esc, layout } = require('./admin-html');
const { renderMain } = require('./admin-dashboard-main');
const { rangeControls } = require('./admin-dashboard-view');
const { number } = require('./admin-dashboard-format');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const reportingCurrency = require('./reporting-currency');
const runtimeSettings = require('./runtime-settings');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
}

// Page-chrome pieces specific to this dashboard's own layout (setup nudge +
// operational alert row above the widget grid) -- kept local rather than
// added to admin-dashboard-view.js, which is main's thin compatibility
// facade for the legacy renderer and not meant to grow new exports.
function setupCompact(s) {
    const setup = s.setup;
    if (!setup || setup.configuredCount >= setup.totalCount) return '';
    return `<div class="setupCompact"><div><strong>Platform setup is not complete</strong><br><span>${esc(setup.configuredCount)} / ${esc(setup.totalCount)} configured · finish the optional setup areas when you are ready.</span></div><a class="button secondary" href="/admin/setup">Open Setup</a></div>`;
}

function operationalAlerts(s) {
    const o = s.operational || {};
    const items = [
        [o.offline_servers, 'offline servers', '/admin/servers'],
        [o.provisioning_problems, 'provisioning problems', '/admin/provisioning'],
        [o.payment_errors_24h, 'payment errors · 24h', '/admin/payments'],
        [o.request_sync_problems, 'request sync problems', '/admin/request-users']
    ];
    return `<div class="dashboardAlertRow">${items.map(([value, label, href]) => `<a class="dashboardAlert ${Number(value) ? 'warn' : ''}" href="${href}" style="text-decoration:none"><strong>${number(value)}</strong>${esc(label)}</a>`).join('')}</div>`;
}

function primaryAction(stats) {
    if (!stats.setup?.counts?.plans) return '<a class="button" href="/admin/plans">+ Create plan</a>';
    if (!stats.setup?.counts?.servers) return '<a class="button" href="/admin/servers/new">+ Add server</a>';
    return '<a class="button" href="/admin/users/new">+ Add customer</a>';
}

function messageBlock(req){return `${req.query.message?`<div class="notice success">${String(req.query.message).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>`:''}${req.query.error?`<div class="notice error">${String(req.query.error).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</div>`:''}`}

async function dashboardPage(req, res) {
    if (!isNativeAdmin(req)) return res.redirect('/login?session=expired');
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    try {
        await Promise.all([runtimeSettings.ensureLoaded(),reportingCurrency.refreshRates().catch(()=>null)]);
        const { ctx, html } = await renderMain(req);
        const stats = ctx.data;
        const body = `${messageBlock(req)}${rangeControls(ctx.range)}${setupCompact(stats)}${operationalAlerts(stats)}${html}`;
        return res.send(layout({
            siteName: runtimeSettings.siteName(),
            active: 'dashboard',
            title: 'Admin Dashboard',
            subtitle: `Business and streaming performance · ${ctx.range.label} · ${ctx.reporting.currency}`,
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

module.exports = { dashboardPage, dashboardData, primaryAction, dashboardRange };
