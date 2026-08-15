'use strict';

const core = require('./admin-html-core');

function layout(options = {}) {
    const requested = options.active || 'dashboard';
    const mapped = requested === 'automation-jobs' ? 'provisioning'
        : requested === 'commerce-overview' ? 'plans'
        : ['configuration-health','reseller-settings'].includes(requested) ? 'settings'
        : ['search','events'].includes(requested) ? 'dashboard'
        : requested;
    let html = core.layout({ ...options, active: mapped });

    const automationLink = `<a class="adminSubTab ${requested==='automation-jobs'?'active':''}" href="/admin/automation">Jobs</a>`;
    if (!html.includes('href="/admin/automation"')) {
        html = html.replace(/(<a class="adminSubTab[^"]*" href="\/admin\/notifications">Notifications<\/a>)/, `$1${automationLink}`);
    }

    const commerceLink = `<a class="adminSubTab ${requested==='commerce-overview'?'active':''}" href="/admin/commerce">Overview</a>`;
    if (!html.includes('href="/admin/commerce"')) {
        html = html.replace(/(<a class="adminSubTab[^"]*" href="\/admin\/plans">Plans<\/a>)/, `${commerceLink}$1`);
    }

    const resellerSettings = `<a class="adminSubTab ${requested==='reseller-settings'?'active':''}" href="/admin/settings/resellers">Reseller Settings</a>`;
    const configHealth = `<a class="adminSubTab ${requested==='configuration-health'?'active':''}" href="/admin/configuration-health">Configuration Health</a>`;
    if (!html.includes('href="/admin/settings/resellers"')) {
        html = html.replace(/(<a class="adminSubTab[^"]*" href="\/admin\/settings\/branding">Branding<\/a>)/, `$1${resellerSettings}${configHealth}`);
    }

    const quickLinks = `<a class="headerButton ${requested==='search'?'active':''}" href="/admin/search">Search</a><a class="headerButton ${requested==='events'?'active':''}" href="/admin/events">Events</a>`;
    if (!html.includes('href="/admin/search"')) {
        html = html.replace('<a class="headerButton hideMobile" href="/"', `${quickLinks}<a class="headerButton hideMobile" href="/"`);
    }
    return html;
}

module.exports = { ...core, layout };
