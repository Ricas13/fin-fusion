'use strict';

const { esc } = require('./admin-html');

const KINDS = new Set(['good', 'warn', 'bad', 'accent']);
function safeKind(value) { return KINDS.has(String(value || '')) ? String(value) : ''; }
function statusBadge(label, kind = '') {
    return `<span class="pill ${safeKind(kind)}">${esc(label)}</span>`;
}
function notice(kind, message, { title = '' } = {}) {
    if (!message) return '';
    const cleanKind = kind === 'error' ? 'error' : kind === 'success' ? 'success' : kind === 'warn' ? 'warn' : '';
    const role = cleanKind === 'error' ? 'alert' : 'status';
    return `<div class="notice ${cleanKind}" role="${role}">${title ? `<strong>${esc(title)}</strong> ` : ''}${esc(message)}</div>`;
}
function noticesFromRequest(req) {
    return `${notice('success', req?.query?.message)}${notice('error', req?.query?.error)}`;
}
function emptyState({ title, body = '', actionHref = '', actionLabel = '', tone = 'neutral' }) {
    const cleanTone = ['neutral', 'success', 'warn', 'danger'].includes(tone) ? tone : 'neutral';
    const action = actionHref && actionLabel ? `<a class="button secondary btn-sm" href="${esc(actionHref)}">${esc(actionLabel)}</a>` : '';
    return `<div class="uiEmptyState uiEmptyState-${cleanTone}"><div><strong>${esc(title)}</strong>${body ? `<span>${esc(body)}</span>` : ''}</div>${action}</div>`;
}
function sectionHeader({ title, description = '', actionsHtml = '', eyebrow = '' }) {
    return `<div class="uiSectionHeader"><div>${eyebrow ? `<span class="uiEyebrow">${esc(eyebrow)}</span>` : ''}<h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>${actionsHtml ? `<div class="uiSectionActions">${actionsHtml}</div>` : ''}</div>`;
}
function confirmationPanel({ tone = 'warn', title, body = '', items = [], choicesHtml = '', actionsHtml = '' }) {
    const cleanTone = ['warn', 'danger', 'info'].includes(tone) ? tone : 'warn';
    const itemList = Array.isArray(items) && items.length ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '';
    return `<section class="uiConfirmPanel uiConfirmPanel-${cleanTone}"><div class="uiConfirmCopy"><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ''}${itemList}</div>${choicesHtml ? `<div class="uiConfirmChoices">${choicesHtml}</div>` : ''}${actionsHtml ? `<div class="uiConfirmActions">${actionsHtml}</div>` : ''}</section>`;
}
function dangerZone({ title = 'Danger zone', description = '', bodyHtml = '', actionsHtml = '' }) {
    return `<section class="uiDangerZone">${sectionHeader({ title, description })}${bodyHtml ? `<div class="uiDangerBody">${bodyHtml}</div>` : ''}${actionsHtml ? `<div class="uiDangerActions">${actionsHtml}</div>` : ''}</section>`;
}

module.exports = { safeKind, statusBadge, notice, noticesFromRequest, emptyState, sectionHeader, confirmationPanel, dangerZone };
