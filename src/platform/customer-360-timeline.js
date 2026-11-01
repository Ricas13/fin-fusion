'use strict';

// One merged, newest-first activity log for the customer page: portal sign-ins and security events, changes an
// administrator made, payments and payment problems, and service (provisioning) runs.
//
// Payments and incidents are passed in (the financial ledger is only read through provider-financial-state); this module itself
// only reads auth_events and audit_log, both through their (user_id, created_at) / (entity_type, entity_id, created_at) indexes
// (no JSON-metadata scans, so the page stays fast on a large audit log). Nothing here writes anything.

const { query } = require('../db');
const moneyFormat = require('./money-format');
const { esc } = require('./html-primitives');

const CATEGORIES = Object.freeze([
    ['security', 'Sign-ins & security'],
    ['admin', 'Admin changes'],
    ['payment', 'Payments'],
    ['service', 'Service']
]);
const MAX_ENTRIES = 150;

// auth_events.event_type -> [title, tone]. login.password_accepted is skipped: it always precedes a session event.
const AUTH_EVENTS = Object.freeze({
    'login.session_created': ['Signed in to the portal', ''],
    'login.password_failed': ['Failed sign-in (wrong password)', 'bad'],
    'login.account_locked': ['Account locked after repeated failed sign-ins', 'bad'],
    'login.inactive_account': ['Sign-in refused: account is inactive', 'warn'],
    'password.changed': ['Portal password changed', ''],
    'password.change_failed': ['Portal password change failed', 'warn'],
    'session.logout': ['Signed out', ''],
    'session.revoke_others': ['Signed out all other devices', ''],
    'session.user_agent_changed': ['Browser or device changed during a session', 'warn']
});
const SKIPPED_AUTH_EVENTS = new Set(['login.password_accepted']);

// Common admin actions get a plain sentence; anything else is humanised from its action name.
const ADMIN_ACTIONS = Object.freeze({
    'admin.customer.ban': 'Customer banned',
    'admin.customer.unban': 'Customer unbanned',
    'admin.customer.jellyfin_password.change': 'Jellyfin password changed',
    'admin.customer.jellyfin.force_recover': 'Jellyfin account force-recovered',
    'admin.customer.server_assign': 'Assigned to a server',
    'admin.customer.server_move.force': 'Moved to another server',
    'admin.customer.plan_change.capacity_override': 'Plan changed onto a full plan (override)',
    'admin.customer.server_assign.capacity_override': 'Assigned to a full server (override)',
    'admin.customer.manual_grant': 'Plan added manually',
    'admin.customer.permanent_access.enable': 'Permanent access enabled',
    'admin.customer.permanent_access.revoke': 'Permanent access revoked',
    'admin.customer.service.reconcile': 'Service reconciled',
    'admin.customer.stremio.install.rotate': 'Stremio install link rotated',
    'admin.customer.stremio.install.revoke': 'Stremio install link revoked',
    'admin.impersonation.start': 'Administrator started viewing as this customer',
    'admin.impersonation.end': 'Administrator stopped viewing as this customer',
    'admin.impersonation.portal_password_set': 'Portal password set by an administrator',
    'billing.checkout.dismissed': 'Unpaid checkout dismissed',
    'billing.checkout.auto_closed': 'Unpaid checkout closed automatically',
    'billing.checkout.marked_paid': 'Checkout recorded as paid by an administrator',
    'billing.checkout.dismissed_then_paid': 'Dismissed checkout was paid later',
    'billing.refund.recorded_externally_completed': 'Refund made outside the app was recorded',
    'billing.refund.recorded_externally_failed': 'Recording a refund made outside the app failed'
});
const ADMIN_TONES = Object.freeze({ 'billing.refund.recorded_externally_failed': 'bad' });
// Internal progress markers of a multi-step operation: the completed/failed entry above is the one worth showing.
const SKIPPED_ADMIN_ACTIONS = new Set([
    'billing.refund.recorded_externally',
    'billing.refund.recorded_externally_effect',
    'billing.refund.recorded_externally_resumed'
]);
// Pure view-tracking noise that would drown the useful entries.
const NOISY_ADMIN_PREFIXES = ['admin.activity.view', 'admin.dashboard.', 'admin.attention.'];

function humanise(action) {
    const cleaned = String(action || 'activity').replace(/^admin\./, '').replace(/^customer\./, '').replace(/^billing\./, '')
        .replaceAll('.', ' · ').replaceAll('_', ' ').trim();
    return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Activity';
}

// Payment status -> display state. Providers use different words (Stripe 'succeeded', PayPal 'S'/'COMPLETED', Plisio 'completed').
// Anything not recognised is neutral: an unknown or pending payment is never shown as a success.
const PAYMENT_SETTLED = new Set(['succeeded', 'success', 'completed', 'complete', 'paid', 'settled', 's']);
const PAYMENT_FAILED = new Set(['failed', 'declined', 'denied', 'error', 'canceled', 'cancelled', 'expired', 'd', 'f']);
const PAYMENT_ADVERSE = ['refund', 'reversed', 'reversal', 'disputed', 'dispute', 'chargeback'];
function paymentTone(type, status) {
    const kind = String(type || '').toLowerCase();
    const state = String(status || '').toLowerCase();
    // An explicitly failed payment is a failure whatever its type (a failed refund is a failure, not just "adverse").
    if (PAYMENT_FAILED.has(state)) return 'bad';
    if (PAYMENT_ADVERSE.some(word => kind.includes(word) || state.includes(word)) || state === 'v') return 'warn';
    if (PAYMENT_SETTLED.has(state)) return 'good';
    return '';
}

function took(startedAt, completedAt) {
    const start = new Date(startedAt).getTime(), end = new Date(completedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
    const seconds = Math.round((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function time(value) {
    const stamp = new Date(value).getTime();
    return Number.isFinite(stamp) ? stamp : 0;
}

// Pure: turn raw rows from the different sources into one sorted list of { at, category, title, detail, tone }.
function build({ auth = [], audit = [], payments = [], incidents = [], runs = [] } = {}) {
    const entries = [];
    for (const row of auth) {
        const type = String(row.event_type || '');
        if (SKIPPED_AUTH_EVENTS.has(type)) continue;
        const known = AUTH_EVENTS[type];
        const failed = row.success === false;
        entries.push({
            at: row.created_at, category: 'security',
            title: known ? known[0] : humanise(type),
            detail: '', tone: known ? known[1] : (failed ? 'bad' : '')
        });
    }
    for (const row of audit) {
        const action = String(row.action || '');
        if (SKIPPED_ADMIN_ACTIONS.has(action) || NOISY_ADMIN_PREFIXES.some(prefix => action.startsWith(prefix))) continue;
        const note = row.metadata && typeof row.metadata === 'object' ? String(row.metadata.reason || row.metadata.note || '').trim() : '';
        entries.push({
            at: row.created_at, category: 'admin',
            title: ADMIN_ACTIONS[action] || humanise(action),
            detail: [row.actor_name ? `by ${row.actor_name}` : '', note].filter(Boolean).join(' · '),
            tone: ADMIN_TONES[action] || ''
        });
    }
    // An outside refund is recorded in steps. If the last step written is a progress marker (and no completed/failed entry exists for the
    // same submission), the operation is unfinished: show it, so an interrupted refund can never silently disappear from the log.
    const refundSteps = new Map();
    for (const row of audit) {
        const action = String(row.action || '');
        if (!action.startsWith('billing.refund.recorded_externally')) continue;
        const sid = row.metadata && typeof row.metadata === 'object' ? String(row.metadata.submissionId || '') : '';
        const key = sid || `row-${row.id || row.created_at}`;
        const group = refundSteps.get(key) || { terminal: false, latest: null, actor: '' };
        if (action.endsWith('_completed') || action.endsWith('_failed')) group.terminal = true;
        if (!group.latest || time(row.created_at) > time(group.latest)) { group.latest = row.created_at; group.actor = row.actor_name || ''; }
        refundSteps.set(key, group);
    }
    for (const group of refundSteps.values()) {
        if (group.terminal || !group.latest) continue;
        entries.push({
            at: group.latest, category: 'admin',
            title: 'Refund made outside the app is not finished',
            detail: [group.actor ? `by ${group.actor}` : '', 'recording started but did not complete; check the Payments card'].filter(Boolean).join(' · '),
            tone: 'warn'
        });
    }
    for (const row of payments) {
        const status = String(row.transaction_status || '').toLowerCase();
        const type = String(row.transaction_type || 'payment').replaceAll('_', ' ');
        entries.push({
            at: row.occurred_at, category: 'payment',
            title: `${type.charAt(0).toUpperCase()}${type.slice(1)}${status ? ` · ${status}` : ''}`,
            detail: `${moneyFormat.formatMinor(row.gross_amount_minor || 0, row.currency || 'GBP')}${row.provider ? ` via ${row.provider}` : ''}`,
            tone: paymentTone(type, status)
        });
    }
    for (const row of incidents) {
        entries.push({
            at: row.created_at, category: 'payment',
            title: `Payment incident: ${String(row.incident_type || 'incident').replaceAll('_', ' ')}`,
            detail: `${row.incident_status || 'open'}${row.provider ? ` · ${row.provider}` : ''}${row.amount_minor != null ? ` · ${moneyFormat.formatMinor(row.amount_minor, row.currency || 'GBP')}` : ''}`,
            tone: row.resolved_at ? '' : 'bad'
        });
    }
    for (const row of runs) {
        entries.push({
            at: row.started_at || row.completed_at, category: 'service',
            title: humanise(row.action),
            detail: [String(row.status || ''), row.completed_at ? `finished ${when(row.completed_at)}${took(row.started_at, row.completed_at) ? ` (took ${took(row.started_at, row.completed_at)})` : ''}` : (row.started_at ? 'not finished' : '')].filter(Boolean).join(' · '),
            tone: ['failed', 'error'].includes(String(row.status || '').toLowerCase()) ? 'bad' : ''
        });
    }
    return entries.filter(entry => time(entry.at) > 0)
        .sort((a, b) => time(b.at) - time(a.at))
        .slice(0, MAX_ENTRIES);
}

async function load(customerId) {
    const owner = await query('SELECT user_id FROM customers WHERE id=$1', [customerId]).then(r => r.rows[0]?.user_id || null).catch(() => null);
    const [auth, audit] = await Promise.all([
        owner
            ? query(`SELECT event_type,success,created_at FROM auth_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 80`, [owner]).then(r => r.rows).catch(() => [])
            : Promise.resolve([]),
        // Two index-backed lookups, merged: events about the customer, and events about one of the customer's subscriptions (manual
        // plan grants and outside refunds are recorded against the subscription).
        query(`
            SELECT * FROM (
                (SELECT a.id,a.action,a.created_at,a.metadata,COALESCE(NULLIF(u.username,''),'') AS actor_name
                   FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_user_id
                  WHERE a.entity_type='customer' AND a.entity_id=$1::text
                  ORDER BY a.created_at DESC LIMIT 120)
                UNION ALL
                (SELECT a.id,a.action,a.created_at,a.metadata,COALESCE(NULLIF(u.username,''),'') AS actor_name
                   FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_user_id
                  WHERE a.entity_type='subscription' AND a.entity_id IN (SELECT s.id::text FROM subscriptions s WHERE s.customer_id=$1::uuid)
                  ORDER BY a.created_at DESC LIMIT 120)
            ) merged
            ORDER BY created_at DESC, id DESC
            LIMIT 150
        `, [customerId]).then(r => r.rows).catch(() => [])
    ]);
    return { auth, audit };
}

const TONE_CLASS = { good: 'good', warn: 'warn', bad: 'bad' };

function when(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

// CSS-only category filter (radio inputs), so the page needs no script. Every rendering gets its own id prefix, so two logs on one
// page (or the same log rendered twice) can never share radios or labels. The radios sit in a labelled fieldset.
let instanceCounter = 0;

function instanceStyles(prefix, keys) {
    const hide = CATEGORIES.map(([key]) => `#${prefix}-${key}:checked ~ .tlRows .tlRow:not(.tl-${key}){display:none}`).join('');
    const active = keys.map(key => `#${prefix}-${key}:checked ~ .tlBar label[for=${prefix}-${key}]{background:rgba(110,190,255,.16);border-color:var(--accent,#5db7ff);color:var(--text,#e8eef4)}`).join('');
    const focus = keys.map(key => `#${prefix}-${key}:focus-visible ~ .tlBar label[for=${prefix}-${key}]{outline:2px solid var(--accent,#5db7ff);outline-offset:2px}`).join('');
    return `<style>${hide}${active}${focus}</style>`;
}

function render(entries, { lastError = '', idPrefix = null } = {}) {
    const prefix = idPrefix || `tl${++instanceCounter}`;
    const counts = Object.fromEntries(CATEGORIES.map(([key]) => [key, entries.filter(entry => entry.category === key).length]));
    const filters = [['all', 'Everything', entries.length], ...CATEGORIES.map(([key, label]) => [key, label, counts[key]])];
    const radios = filters.map(([key], index) => `<input class="tlRadio" type="radio" name="${prefix}-filter" id="${prefix}-${key}" ${index === 0 ? 'checked' : ''}>`).join('');
    const labels = filters.map(([key, label, count]) => `<label class="tlChip" for="${prefix}-${key}">${esc(label)} <span>${count}</span></label>`).join('');
    const rows = entries.length
        ? entries.map(entry => `<div class="tlRow tl-${esc(entry.category)}"><span class="tlWhen">${esc(when(entry.at))}</span><span class="tlWhat"><strong class="tlTitle ${TONE_CLASS[entry.tone] || ''}">${esc(entry.title)}</strong>${entry.detail ? `<small>${esc(entry.detail)}</small>` : ''}</span><span class="tlCat">${esc((CATEGORIES.find(([key]) => key === entry.category) || [0, entry.category])[1])}</span></div>`).join('')
        : '<div class="opEmpty">No activity recorded yet.</div>';
    return `${lastError ? `<div class="notice error">${esc(lastError)}</div>` : ''}${instanceStyles(prefix, filters.map(([key]) => key))}<fieldset class="tlWrap"><legend class="tlLegend">Filter the log by type</legend>${radios}<div class="tlBar">${labels}</div><div class="tlRows">${rows}</div></fieldset>`;
}

// Shared (id-independent) styling.
function styles() {
    return `<style>.tlWrap{display:block;border:0;margin:0;padding:0;min-width:0}.tlLegend{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.tlRadio{position:absolute;opacity:0;pointer-events:none}.tlBar{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.tlChip{cursor:pointer;border:1px solid var(--border,#29333d);border-radius:999px;padding:4px 11px;font-size:.7rem;color:var(--muted,#9aa7b3)}.tlChip span{opacity:.7;margin-left:3px}.tlRows{display:grid}.tlRow{display:grid;grid-template-columns:150px minmax(0,1fr) 150px;gap:12px;padding:8px 4px;border-bottom:1px solid var(--border,#29333d);align-items:start;font-size:.76rem}.tlWhat{display:grid;gap:2px}.tlWhat small,.tlCat{color:var(--muted,#9aa7b3);font-size:.68rem}.tlTitle.bad{color:var(--danger,#e16c72)}.tlTitle.warn{color:var(--warn,#e0b25b)}.tlTitle.good{color:var(--good,#5cc28b)}@media(max-width:760px){.tlRow{grid-template-columns:1fr}.tlCat{display:none}}</style>`;
}

module.exports = { CATEGORIES, MAX_ENTRIES, build, load, render, styles, humanise };
