'use strict';

const nav = require('./admin-nav');

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
}

const PERSONAL_KEYS = new Set(['my-profile', 'my-notifications', 'my-security']);
const COMMERCE_ANALYTICS = Object.freeze(['commerce-overview', 'Analytics', '/admin/commerce']);

function current(active) {
    const key = nav.activeKey(active);
    const hidden = nav.hiddenPages[key] || null;
    const groupKey = hidden?.groupKey || nav.groupFor(key).key;
    const group = nav.groups.find(item => item.key === groupKey) || nav.groups[0];
    const page = hidden?.page || group.pages.find(item => item[0] === key) || group.pages[0];
    const parent = hidden ? group.pages.find(item => item[0] === hidden.parentKey) || null : null;
    return { key, hidden, group, page, parent, sidebarKey: nav.sidebarKey(key) };
}

function sectionPages(active) {
    const info = current(active);
    if (info.group.key === 'dashboard' || PERSONAL_KEYS.has(info.key)) return [];
    if (info.group.key === 'commerce') return [...info.group.pages, COMMERCE_ANALYTICS];
    return info.group.pages;
}

function sectionActiveKey(active) {
    const info = current(active);
    if (info.key === 'commerce-overview') return 'commerce-overview';
    return info.sidebarKey;
}

function subPages(active) {
    const info = current(active);
    if (PERSONAL_KEYS.has(info.key)) return [];
    if (info.key === 'commerce-overview') return [COMMERCE_ANALYTICS];
    if (info.sidebarKey === 'activity') {
        return [
            ['activity-live', 'Live playback', '/admin/activity'],
            ['activity-policy', 'Policy settings', '/admin/activity#playback-policy']
        ];
    }
    const pages = nav.workflowPages(info.key);
    return pages.length > 1 ? pages : [];
}

function subActiveKey(active, locationHint = '') {
    const info = current(active);
    if (info.sidebarKey !== 'activity') return info.key;
    return String(locationHint || '').includes('playback-policy') ? 'activity-policy' : 'activity-live';
}

function tabRow(items, activeKey, className, label) {
    if (!items.length) return '';
    const linkClass = className === 'coherenceSubTabs' ? 'coherenceSubTab' : 'coherenceSectionTab';
    const links = items.map(([key, text, href]) => {
        const selected = key === activeKey;
        return `<a class="${linkClass}${selected ? ' active' : ''}" href="${esc(href)}"${selected ? ' aria-current="page"' : ''}>${esc(text)}</a>`;
    }).join('');
    return `<nav class="${esc(className)}" aria-label="${esc(label)}">${links}</nav>`;
}

function render(active, { locationHint = '' } = {}) {
    const info = current(active);
    const sections = sectionPages(active);
    const subs = subPages(active);
    return [
        tabRow(sections, sectionActiveKey(active), 'coherenceSectionTabs', `${info.group.label} sections`),
        tabRow(subs, subActiveKey(active, locationHint), 'coherenceSubTabs', `${info.page[1]} pages`)
    ].filter(Boolean).join('');
}

function breadcrumb(active) {
    const info = current(active);
    const pieces = [];
    const groupHref = info.group.key === 'commerce' ? '/admin/commerce' : nav.landingFor(info.group);
    pieces.push(`<a href="${esc(groupHref)}">${esc(info.group.label)}</a>`);
    const omitParent = info.key === 'commerce-overview';
    if (!omitParent && info.parent && info.parent[0] !== info.page[0]) {
        pieces.push(`<a href="${esc(info.parent[2])}">${esc(info.parent[1])}</a>`);
    }
    pieces.push(`<strong>${esc(info.key === 'commerce-overview' ? 'Analytics' : info.page[1])}</strong>`);
    return pieces.join('<span class="breadcrumbSep" aria-hidden="true">/</span>');
}

function model(active) {
    return {
        sectionPages: sectionPages(active),
        sectionActiveKey: sectionActiveKey(active),
        subPages: subPages(active),
        subActiveKey: subActiveKey(active),
        breadcrumbHtml: breadcrumb(active)
    };
}

module.exports = { current, sectionPages, sectionActiveKey, subPages, subActiveKey, tabRow, render, breadcrumb, model, COMMERCE_ANALYTICS };
