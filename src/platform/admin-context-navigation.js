'use strict';

const nav = require('./admin-nav');

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

const PERSONAL_KEYS = new Set(['my-profile', 'my-notifications', 'my-security']);

const TOOL_DESCRIPTIONS = Object.freeze({
    search: 'Search across customers, plans and servers.',
    attention: 'Review the operational exceptions that still need a human decision.',
    'stremio-playback': 'Review household/IP access and managed Stremio playback.',
    'reseller-accounts': 'Manage reseller organisations and account state.',
    'users-dashboard': 'Review customer lifecycle, growth and access activity.',
    'customer-claims': 'Let imported Jellyfin users claim their existing account in the portal.',
    'jellyfin-import': 'Import existing Jellyfin users without recreating their server accounts.',
    'customer-jellyfin-password': 'Support an existing customer with Jellyfin credential recovery.',
    'commerce-overview': 'Review revenue, MRR, churn and checkout performance.',
    discounts: 'Manage promotions, coupon rules and redemption state.',
    referrals: 'Manage affiliate referrals and service-credit rewards.',
    'storefront-order': 'Control how plans are ordered on the storefront.',
    'plan-access-rules': 'Manage advanced access and delivery rules for plans.',
    billing: 'Review billing state and billing-specific controls.',
    'provider-mappings': 'Manage provider product and price mappings.',
    'payment-risk-policy': 'Review payment-risk and fraud-protection policy.',
    'server-migrations': 'Move customers between eligible servers safely.',
    'policy-drift': 'Review and repair access-policy inconsistencies.',
    events: 'Review the full administrator and system audit history.',
    'configuration-transfer': 'Export or import supported CAPTAiNFiN configuration.',
    branding: 'Manage the shared logo, icon and customer-facing brand assets.',
    'support-policy': 'Manage support, legal and public policy information.',
    'notification-settings': 'Choose global notification channels and event permissions.',
    'notification-gateway': 'Manage transactional email infrastructure and delivery health.',
    'request-service': 'Manage request-service connection and account synchronisation.',
    'admin-2fa-policy': 'Manage the global administrator two-factor policy.'
});

const EXTRA_OWNER_TOOLS = Object.freeze({
    servers: Object.freeze([
        ['servers-dashboard', 'Fleet dashboard', '/admin/servers/dashboard', 'Live fleet health, capacity, playback and library analytics.'],
        ['fleet-operations', 'Placement & capacity', '/admin/servers/operations', 'Placement modes, health policy and future-capacity planning.'],
        ['libraries', 'Libraries', '/admin/libraries', 'Fleet library discovery, availability and visibility.']
    ]),
    activity: Object.freeze([
        ['inactivity-policy', 'Free-user inactivity rules', '/admin/activity/inactivity-policy', 'Configure inactivity handling for free Jellyfin access.']
    ]),
    'settings-security': Object.freeze([
        ['abuse-protection', 'Turnstile & abuse protection', '/admin/settings/abuse-protection', 'Configure public anti-abuse checks for sign-in and registration.']
    ])
});

function current(active) {
    const rawKey = String(active || 'dashboard');
    const key = nav.activeKey(rawKey);
    const hidden = nav.hiddenPages[key] || null;
    const groupKey = hidden?.groupKey || nav.groupFor(key).key;
    const group = nav.groups.find(item => item.key === groupKey) || nav.groups[0];
    const page = hidden?.page || group.pages.find(item => item[0] === key) || group.pages[0];
    const parent = hidden ? group.pages.find(item => item[0] === hidden.parentKey) || null : null;
    return { rawKey, key, hidden, group, page, parent, sidebarKey: nav.sidebarKey(key) };
}

function sectionPages(active) {
    const info = current(active);
    if (info.group.key === 'dashboard' || PERSONAL_KEYS.has(info.key)) return [];
    return info.group.pages;
}

function sectionActiveKey(active) {
    return current(active).sidebarKey;
}

// Compatibility exports only. Secondary upper-tab rows are intentionally retired:
// deeper destinations now belong to the owning main tab as ordinary page tools.
function subPages() { return []; }
function subActiveKey() { return null; }

function tabRow(items, activeKey, className = 'coherenceSectionTabs', label = 'Page sections') {
    if (!items.length || className === 'coherenceSubTabs') return '';
    const links = items.map(([key, text, href]) => {
        const selected = key === activeKey;
        return `<a class="workflowCard coherenceSectionTab${selected ? ' active' : ''}" href="${esc(href)}"${selected ? ' aria-current="page"' : ''}><span class="workflowCardEyebrow">${selected ? 'Current' : 'Related'}</span><strong>${esc(text)}</strong></a>`;
    }).join('');
    return `<nav class="workflowCardGrid coherenceSectionTabs" aria-label="${esc(label)}">${links}</nav>`;
}

function render(active) {
    const info = current(active);
    return tabRow(sectionPages(active), sectionActiveKey(active), 'coherenceSectionTabs', `${info.group.label} sections`);
}

function ownedToolPages(active) {
    const info = current(active);
    if (PERSONAL_KEYS.has(info.key) || info.hidden) return [];
    const rows = [];
    for (const child of Object.values(nav.hiddenPages)) {
        if (child.groupKey !== info.group.key || child.parentKey !== info.sidebarKey || child.page[0] === 'search') continue;
        const [key, label, href] = child.page;
        if (key === info.rawKey) continue;
        rows.push([key, label, href, TOOL_DESCRIPTIONS[key] || 'Open this specialist tool.']);
    }
    for (const row of EXTRA_OWNER_TOOLS[info.sidebarKey] || []) {
        if (row[0] === info.rawKey) continue;
        rows.push(row);
    }
    const seen = new Set();
    return rows.filter(row => {
        if (seen.has(row[2])) return false;
        seen.add(row[2]);
        return true;
    });
}

function renderOwnedTools(active) {
    const info = current(active);
    const tools = ownedToolPages(active);
    if (!tools.length) return '';
    const cards = tools.map(([_key, label, href, description]) => `<a class="coherenceOwnedTool" href="${esc(href)}"><strong>${esc(label)}</strong><span>${esc(description)}</span><small>Open →</small></a>`).join('');
    return `<section class="coherenceOwnedTools" aria-label="${esc(info.page?.[1] || info.group.label)} tools"><div class="coherenceOwnedToolsHead"><div><h2>More in ${esc(info.page?.[1] || info.group.label)}</h2><p>Specialist controls live inside this main area instead of creating another row of tabs.</p></div></div><div class="coherenceOwnedToolsGrid">${cards}</div></section>`;
}

function breadcrumb(active) {
    const info = current(active);
    const pieces = [];
    const groupHref = info.group.key === 'commerce' ? '/admin/commerce' : nav.landingFor(info.group);
    pieces.push(`<a href="${esc(groupHref)}">${esc(info.group.label)}</a>`);
    if (info.parent && info.parent[0] !== info.page[0]) pieces.push(`<a href="${esc(info.parent[2])}">${esc(info.parent[1])}</a>`);
    pieces.push(`<strong>${esc(info.page?.[1] || info.group.label)}</strong>`);
    return pieces.join('<span class="breadcrumbSep" aria-hidden="true">/</span>');
}

function model(active) {
    return {
        sectionPages: sectionPages(active),
        sectionActiveKey: sectionActiveKey(active),
        subPages: [],
        subActiveKey: null,
        ownedTools: ownedToolPages(active),
        breadcrumbHtml: breadcrumb(active)
    };
}

module.exports = { current, sectionPages, sectionActiveKey, subPages, subActiveKey, tabRow, render, ownedToolPages, renderOwnedTools, breadcrumb, model, TOOL_DESCRIPTIONS, EXTRA_OWNER_TOOLS };
