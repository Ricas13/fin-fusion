'use strict';

const csrf=require('../auth/csrf');
const { layout } = require('./admin-html');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const { renderDashboard } = require('./admin-dashboard-view');
const forecast=require('./admin-revenue-forecast');
const runtimeSettings = require('./runtime-settings');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
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
        await runtimeSettings.ensureLoaded();
        const range = dashboardRange(req.query || {});
        const [stats,prospect] = await Promise.all([dashboardData(range),forecast.data({weeks:12})]);
        return res.send(layout({
            siteName: runtimeSettings.siteName(),
            active: 'dashboard',
            title: 'Admin Dashboard',
            subtitle: `Business and streaming performance · ${range.label}`,
            body: `${messageBlock(req)}${forecast.render(prospect,csrf.token(req))}${renderDashboard(stats)}`,
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
