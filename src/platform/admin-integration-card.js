'use strict';

const { esc } = require('./admin-html');

function safeKind(value) {
    return ['good','warn','bad','accent'].includes(value) ? value : '';
}
function date(value) {
    if (!value) return 'Not yet observed';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Not yet observed' : parsed.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function fact(label, value, kind = '') {
    return `<div class="integrationFact"><span>${esc(label)}</span><strong class="${safeKind(kind) ? `integrationFact-${safeKind(kind)}` : ''}">${esc(value)}</strong></div>`;
}
function renderIntegrationCard({
    name,
    statusLabel,
    statusKind = '',
    summary = '',
    enabled = null,
    configured = null,
    workingLabel = 'Not yet observed',
    workingKind = '',
    lastVerifiedAt = null,
    lastVerifiedLabel = 'Last verified',
    fixHint = '',
    actionsHtml = ''
}) {
    const facts = [];
    if (enabled != null) facts.push(fact('Enabled', enabled ? 'Yes' : 'No', enabled ? 'good' : ''));
    if (configured != null) facts.push(fact('Configured', configured ? 'Yes' : 'No', configured ? 'good' : 'warn'));
    facts.push(fact('Current state', workingLabel, workingKind));
    facts.push(fact(lastVerifiedLabel, date(lastVerifiedAt)));
    return `<article class="integrationCard"><div class="integrationCardHead"><div><h3>${esc(name)}</h3>${summary ? `<p>${esc(summary)}</p>` : ''}</div><span class="pill ${safeKind(statusKind)}">${esc(statusLabel)}</span></div><div class="integrationFacts">${facts.join('')}</div>${fixHint ? `<div class="integrationFix"><strong>If this is not working</strong><span>${esc(fixHint)}</span></div>` : ''}${actionsHtml ? `<div class="integrationActions">${actionsHtml}</div>` : ''}</article>`;
}
function styles() {
    return '<link rel="stylesheet" href="/css/admin-integration-cards.css">';
}

module.exports = { renderIntegrationCard, styles, date };
