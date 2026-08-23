'use strict';

// Keep shared UI primitives independent from the page-shell renderer. The
// shell itself consumes workflow-card helpers, so importing admin-html here
// would create a circular dependency during application startup.
function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

const KINDS = new Set(['good', 'warn', 'bad', 'accent']);
const PAGE_STATUS_HERO_ENABLED = false;
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
function workflowCards(items, active = '', label = 'Related controls') {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return '';
    // operatorTabs is retained as a semantic/test compatibility hook while
    // workflowCardGrid owns the visual layout. This lets older automation find
    // one workflow navigation region without forcing the UI back to tab strips.
    return `<nav class="workflowCardGrid operatorTabs" aria-label="${esc(label)}">${rows.map(item => {
        const values = Array.isArray(item) ? item : [item.key, item.title, item.href, item.description];
        const [key, title, href, description = 'Open this part of the workflow'] = values;
        const selected = String(key) === String(active);
        return `<a class="workflowCard ${selected ? 'active' : ''}" href="${esc(href)}" ${selected ? 'aria-current="page"' : ''}><span class="workflowCardEyebrow">${selected ? 'Current' : 'Related'}</span><strong>${esc(title)}</strong><span>${esc(description)}</span><small>${selected ? 'You are here' : 'Open →'}</small></a>`;
    }).join('')}</nav>`;
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
    // Page-level control-room/status heroes became visually dominant as the
    // admin surface matured. Keep the primitive for backwards compatibility,
    // but retire it from the rendered UI by default so pages begin with the
    // controls and data the operator actually came to use.
    if (!PAGE_STATUS_HERO_ENABLED) return '';
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

module.exports = { safeKind, statusBadge, notice, noticesFromRequest, emptyState, sectionHeader, workflowCards, confirmationPanel, dangerZone, operatorHero, resolutionCard, detailDisclosure };
