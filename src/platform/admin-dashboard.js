'use strict';

const { layout } = require('./admin-html');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange } = require('./admin-dashboard-analytics');
const { renderDashboard } = require('./admin-dashboard-view');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
}

function primaryAction(stats) {
    if (!stats.setup?.counts?.plans) return '<a class="button" href="/admin/plans">+ Create plan</a>';
    if (!stats.setup?.counts?.servers) return '<a class="button" href="/admin/servers/new">+ Add server</a>';
    return '<a class="button" href="/admin/users/new">+ Add customer</a>';
}

async function dashboardPage(req, res) {
    if (!isNativeAdmin(req)) return res.redirect('/login?session=expired');
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    try {
        const range = dashboardRange(req.query || {});
        const stats = await dashboardData(range);
        return res.send(layout({
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            active: 'dashboard',
            title: 'Admin Dashboard',
            subtitle: `Business and streaming performance · ${range.label}`,
            body: renderDashboard(stats),
            action: primaryAction(stats)
        }));
    } catch (error) {
        console.error('Admin dashboard failed:', error.message);
        return res.status(500).render('auth/message', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            title: 'Dashboard unavailable',
            message: 'The administration dashboard could not be loaded safely.',
            link: '/admin/setup',
            linkText: 'Open Setup'
        });
    }
}

module.exports = { dashboardPage, dashboardData, primaryAction, dashboardRange };
