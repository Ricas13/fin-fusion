'use strict';

const core = require('./admin-html-core');

function layout(options = {}) {
    const requested = options.active || 'dashboard';
    const mapped = requested === 'automation-jobs' ? 'provisioning'
        : ['search','events'].includes(requested) ? 'dashboard'
        : requested;
    let html = core.layout({ ...options, active: mapped });

    const automationActive = requested === 'automation-jobs' ? 'active' : '';
    const automationLink = `<a class="adminSubTab ${automationActive}" href="/admin/automation">Jobs</a>`;
    if (!html.includes('href="/admin/automation"')) {
        html = html.replace(/(<a class="adminSubTab[^"]*" href="\/admin\/notifications">Notifications<\/a>)/, `$1${automationLink}`);
    }

    const quickLinks = `<a class="headerButton ${requested==='search'?'active':''}" href="/admin/search">Search</a><a class="headerButton ${requested==='events'?'active':''}" href="/admin/events">Events</a>`;
    if (!html.includes('href="/admin/search"')) {
        html = html.replace('<a class="headerButton hideMobile" href="/"', `${quickLinks}<a class="headerButton hideMobile" href="/"`);
    }
    return html;
}

module.exports = { ...core, layout };
