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
function operatorHero({ tone = 'info', eyebrow = 'Current state', title, body = '', statusLabel = '', facts = [], actionsHtml = '', next = '' }) {
    const cleanTone = ['good', 'warn', 'bad', 'info', 'commerce', 'streaming'].includes(tone) ? tone : 'info';
    const factHtml = Array.isArray(facts) && facts.length
        ? `<div class="operatorHeroFacts">${facts.map(fact => `<div class="operatorHeroFact"><span>${esc(fact.label || '')}</span><strong>${esc(fact.value ?? '—')}</strong>${fact.detail ? `<small>${esc(fact.detail)}</small>` : ''}</div>`).join('')}</div>`
        : '';
    const status = statusLabel ? `<span class="operatorHeroStatus">${esc(statusLabel)}</span>` : '';
    return `<section class="operatorHero operatorHero-${cleanTone}"><div class="operatorHeroTop"><div><span class="uiEyebrow">${esc(eyebrow)}</span><h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}</div>${status}</div>${next ? `<div class="operatorNext"><span>Do this next</span><strong>${esc(next)}</strong></div>` : ''}${factHtml}${actionsHtml ? `<div class="operatorHeroActions">${actionsHtml}</div>` : ''}</section>`;
}
function resolutionCard({ tone = 'warn', title, body = '', reason = '', actionHtml = '', secondaryHtml = '', badge = 'Action needed' }) {
    const cleanTone = ['warn', 'bad', 'info', 'good'].includes(tone) ? tone : 'warn';
    return `<section class="operatorResolution operatorResolution-${cleanTone}" role="${cleanTone === 'bad' ? 'alert' : 'status'}"><div class="operatorResolutionIcon" aria-hidden="true">${cleanTone === 'good' ? '✓' : cleanTone === 'bad' ? '!' : cleanTone === 'warn' ? '!' : 'i'}</div><div class="operatorResolutionCopy"><span class="operatorResolutionBadge">${esc(badge)}</span><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}${reason ? `<div class="operatorWhy"><strong>Why:</strong> ${esc(reason)}</div>` : ''}</div>${actionHtml || secondaryHtml ? `<div class="operatorResolutionActions">${actionHtml}${secondaryHtml}</div>` : ''}</section>`;
}
function detailDisclosure({ title, summary = 'Advanced details', bodyHtml = '' }) {
    return `<details class="operatorDetails"><summary><span>${esc(title || summary)}</span><small>${esc(summary)}</small></summary><div class="operatorDetailsBody">${bodyHtml}</div></details>`;
}

module.exports = { safeKind, statusBadge, notice, noticesFromRequest, emptyState, sectionHeader, confirmationPanel, dangerZone, operatorHero, resolutionCard, detailDisclosure };
