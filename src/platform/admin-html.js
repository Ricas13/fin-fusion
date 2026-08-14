'use strict';

const branding = require('./branding');

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

const groups = [
    ['dashboard', 'Dashboard', [['dashboard', 'Dashboard', '/admin']]],
    ['people', 'People', [['users', 'Customers', '/admin/users'], ['jellyfin-import', 'Jellyfin Import', '/admin/jellyfin-import'], ['customer-claims', 'Customer Claims', '/admin/customer-claims'], ['invitations', 'Invitations', '/admin/invitations'], ['resellers', 'Resellers', '/admin/reseller-management'], ['activity', 'Activity', '/admin/activity']]],
    ['servers', 'Servers', [['servers', 'Servers', '/admin/servers'], ['libraries', 'Libraries', '/admin/libraries']]],
    ['commerce', 'Commerce', [['plans', 'Plans', '/admin/plans'], ['payments', 'Payments', '/admin/payments'], ['billing', 'Billing', '/admin/billing'], ['discounts', 'Discounts', '/admin/discounts'], ['referrals', 'Referrals', '/admin/referrals']]],
    ['automation', 'Automation', [['provisioning', 'Provisioning', '/admin/provisioning'], ['notifications', 'Notifications', '/admin/notifications']]],
    ['settings', 'Settings', [['setup', 'Setup', '/admin/setup'], ['settings', 'General', '/admin/settings'], ['branding', 'Branding', '/admin/settings/branding']]]
];

function findGroup(active) {
    for (const group of groups) if (group[2].some(page => page[0] === active)) return group;
    return groups[0];
}

const iconPaths = {
    dashboard: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    servers: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    commerce: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h2"/>',
    automation: '<path d="M18 8a6 6 0 1 0 1.76 4.24"/><path d="M18 3v5h5"/><path d="m13 9-3 4h4l-3 4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06-.06A1.7 1.7 0 0 0 19.4 9c.2.37.52.68.9.87.33.16.7.24 1.06.23H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>'
};

function icon(key) {
    return `<span class="navIcon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconPaths[key] || iconPaths.dashboard}</svg></span>`;
}

const critical = `*{box-sizing:border-box}:root{--bg:#0c1117;--sidebar:#10151c;--border:#222933;--text:#d9e0e8;--muted:#8390a2;--accent:#20a9d6;--sidebar-w:220px}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px}.appShell{min-height:100vh;background:var(--bg)}.adminHeader{position:fixed;inset:0 auto 0 0;width:var(--sidebar-w);z-index:110;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column}.headerMain{padding:14px 14px 12px}.brandBlock{display:flex;align-items:center;gap:10px;text-decoration:none}.brandLogo{width:30px;height:30px;border-radius:7px;object-fit:cover}.brandText{font-size:14px;font-weight:800;color:#f1f5f9}.brandSub{font-size:10px;color:#667386}.adminTabsWrap{flex:1;overflow:auto;padding:8px 0 132px}.adminTabs{display:flex;flex-direction:column;gap:4px;padding:0 9px}.navGroup{display:grid;gap:2px}.adminTab{display:flex;align-items:center;gap:11px;min-height:38px;padding:8px 11px;border-radius:7px;color:#a2adba;text-decoration:none;font-weight:600;font-size:12px}.navIcon{width:18px;height:18px;display:grid;place-items:center;color:#708094;flex:none}.navIcon svg{width:18px;height:18px}.adminTab.active{color:#fff;background:rgba(32,169,214,.13);box-shadow:inset 3px 0 0 var(--accent)}.adminSubTabs{display:grid;gap:1px;margin:1px 0 5px;padding-left:39px}.adminSubTab{display:block;padding:6px 9px;border-radius:6px;color:#748294;text-decoration:none;font-size:11px;font-weight:600}.adminSubTab.active{color:#39bce7;background:rgba(32,169,214,.07)}.headerActions{position:absolute;left:9px;right:9px;bottom:10px;display:grid;gap:5px}.headerButton{display:flex;padding:6px 9px;color:#8f9bad;text-decoration:none;font-size:11px}.mainPane{min-height:100vh;margin-left:var(--sidebar-w);background:var(--bg)}.topBar{position:sticky;top:0;z-index:95;height:52px;padding:0 22px;display:flex;align-items:center;justify-content:space-between;background:#10151c;border-bottom:1px solid var(--border)}.content{padding:21px 24px 42px}.pageHeader{margin-bottom:16px}.pageHeader h1{margin:0 0 3px;font-size:21px;color:#f1f5f9}.muted{color:var(--muted)}@media(max-width:760px){:root{--sidebar-w:0px}.adminHeader{position:static;width:100%}.adminTabs{flex-direction:row;min-width:max-content}.adminTabsWrap{padding:6px 0;overflow-x:auto}.navGroup{display:flex}.adminSubTabs{display:none}.headerActions{display:none}.mainPane{margin-left:0}}`;

function header(active, site) {
    const activeGroup = findGroup(active);
    const activeGroupKey = activeGroup[0];
    let tabs = '';
    for (const [groupKey, groupLabel, pages] of groups) {
        const isActive = activeGroupKey === groupKey;
        const children = isActive && pages.length > 1
            ? `<div class="adminSubTabs">${pages.map(([key, label, url]) => `<a class="adminSubTab ${active === key ? 'active' : ''}" href="${esc(url)}">${esc(label)}</a>`).join('')}</div>`
            : '';
        tabs += `<div class="navGroup"><a class="adminTab ${isActive ? 'active' : ''}" href="${esc(pages[0][2])}">${icon(groupKey)}<span>${esc(groupLabel)}</span></a>${children}</div>`;
    }
    return `<header class="adminHeader"><div class="headerMain"><a class="brandBlock" href="/admin"><img class="brandLogo" src="${esc(branding.assetUrl('logo'))}" alt=""><div><div class="brandText">${esc(site)}</div><div class="brandSub">Administration</div></div></a></div><div class="adminTabsWrap"><nav class="adminTabs" aria-label="Administration">${tabs}</nav></div><div class="headerActions"><a class="headerButton hideMobile" href="/" target="_blank" rel="noopener noreferrer">Open Store</a><a class="headerButton" href="/admin/security">Security</a><a class="headerButton danger" href="/logout">Sign out</a></div></header>`;
}

function layout(options) {
    const site = options.siteName || 'CAPTaINFiN';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(options.title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><style>${critical}</style><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"><link rel="stylesheet" href="/css/admin-server-library-dashboard.css"><link rel="stylesheet" href="/css/admin-form-feedback.css"></head><body><div class="appShell">${header(options.active, site)}<main class="mainPane"><header class="topBar"><div>Administration</div><div>${options.action || ''}</div></header><div class="content"><div class="pageHeader"><div><h1>${esc(options.title)}</h1><div class="muted">${esc(options.subtitle || '')}</div></div></div>${options.body || ''}</div></main></div><script src="/js/admin-form-feedback.js" defer></script></body></html>`;
}

module.exports = { esc, layout };
