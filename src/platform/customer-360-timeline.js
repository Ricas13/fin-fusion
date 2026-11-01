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
    'billing.checkout.dismissed_then_paid': 'Dismissed checkout was paid later'
});
// Pure view-tracking noise that would drown the useful entries.
const NOISY_ADMIN_PREFIXES = ['admin.activity.view', 'admin.dashboard.', 'admin.attention.'];

function humanise(action) {
    const cleaned = String(action || 'activity').replace(/^admin\./, '').replace(/^customer\./, '').replace(/^billing\./, '')
        .replaceAll('.', ' · ').replaceAll('_', ' ').trim();
    return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Activity';
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
        if (NOISY_ADMIN_PREFIXES.some(prefix => action.startsWith(prefix))) continue;
        const note = row.metadata && typeof row.metadata === 'object' ? String(row.metadata.reason || row.metadata.note || '').trim() : '';
        entries.push({
            at: row.created_at, category: 'admin',
            title: ADMIN_ACTIONS[action] || humanise(action),
            detail: [row.actor_name ? `by ${row.actor_name}` : '', note].filter(Boolean).join(' · '),
            tone: ''
        });
    }
    for (const row of payments) {
        const status = String(row.transaction_status || '').toLowerCase();
        const type = String(row.transaction_type || 'payment').replaceAll('_', ' ');
        const bad = ['failed', 'declined', 'error', 'refund', 'reversed', 'disputed', 'chargeback'].some(word => status.includes(word) || type.includes(word));
        entries.push({
            at: row.occurred_at, category: 'payment',
            title: `${type.charAt(0).toUpperCase()}${type.slice(1)}${status ? ` · ${status}` : ''}`,
            detail: `${moneyFormat.formatMinor(row.gross_amount_minor || 0, row.currency || 'GBP')}${row.provider ? ` via ${row.provider}` : ''}`,
            tone: bad ? 'warn' : 'good'
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
            detail: String(row.status || ''),
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
        query(`
            SELECT a.action,a.created_at,a.metadata,COALESCE(NULLIF(u.username,''),'') AS actor_name
            FROM audit_log a
            LEFT JOIN app_users u ON u.id=a.actor_user_id
            WHERE a.entity_type='customer' AND a.entity_id=$1::text
            ORDER BY a.created_at DESC
            LIMIT 120
        `, [customerId]).then(r => r.rows).catch(() => [])
    ]);
    return { auth, audit };
}

const TONE_CLASS = { good: 'good', warn: 'warn', bad: 'bad' };

function when(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

// CSS-only category filter (radio inputs), so the page needs no script. All styling is in logStyles().
function render(entries, { lastError = '' } = {}) {
    const counts = Object.fromEntries(CATEGORIES.map(([key]) => [key, entries.filter(entry => entry.category === key).length]));
    const filters = [['all', 'Everything', entries.length], ...CATEGORIES.map(([key, label]) => [key, label, counts[key]])];
    const radios = filters.map(([key], index) => `<input class="tlRadio" type="radio" name="tlFilter" id="tlf-${key}" ${index === 0 ? 'checked' : ''}>`).join('');
    const labels = filters.map(([key, label, count]) => `<label class="tlChip" for="tlf-${key}">${esc(label)} <span>${count}</span></label>`).join('');
    const rows = entries.length
        ? entries.map(entry => `<div class="tlRow tl-${esc(entry.category)}"><span class="tlWhen">${esc(when(entry.at))}</span><span class="tlWhat"><strong class="tlTitle ${TONE_CLASS[entry.tone] || ''}">${esc(entry.title)}</strong>${entry.detail ? `<small>${esc(entry.detail)}</small>` : ''}</span><span class="tlCat">${esc((CATEGORIES.find(([key]) => key === entry.category) || [0, entry.category])[1])}</span></div>`).join('')
        : '<div class="opEmpty">No activity recorded yet.</div>';
    return `${lastError ? `<div class="notice error">${esc(lastError)}</div>` : ''}<div class="tlWrap">${radios}<div class="tlBar">${labels}</div><div class="tlRows">${rows}</div></div>`;
}

function styles() {
    const hide = CATEGORIES.map(([key]) => `#tlf-${key}:checked ~ .tlRows .tlRow:not(.tl-${key}){display:none}`).join('');
    const active = ['all', ...CATEGORIES.map(([key]) => key)].map(key => `#tlf-${key}:checked ~ .tlBar label[for=tlf-${key}]{background:rgba(110,190,255,.16);border-color:var(--accent,#5db7ff);color:var(--text,#e8eef4)}`).join('');
    return `<style>.tlWrap{display:block}.tlRadio{position:absolute;opacity:0;pointer-events:none}.tlBar{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.tlChip{cursor:pointer;border:1px solid var(--border,#29333d);border-radius:999px;padding:4px 11px;font-size:.7rem;color:var(--muted,#9aa7b3)}.tlChip span{opacity:.7;margin-left:3px}.tlRows{display:grid}.tlRow{display:grid;grid-template-columns:150px minmax(0,1fr) 150px;gap:12px;padding:8px 4px;border-bottom:1px solid var(--border,#29333d);align-items:start;font-size:.76rem}.tlWhat{display:grid;gap:2px}.tlWhat small,.tlCat{color:var(--muted,#9aa7b3);font-size:.68rem}.tlTitle.bad{color:var(--danger,#e16c72)}.tlTitle.warn{color:var(--warn,#e0b25b)}.tlTitle.good{color:var(--good,#5cc28b)}${hide}${active}.tlRadio:focus-visible ~ .tlBar{outline:2px solid var(--accent,#5db7ff)}@media(max-width:760px){.tlRow{grid-template-columns:1fr}.tlCat{display:none}}</style>`;
}

module.exports = { CATEGORIES, MAX_ENTRIES, build, load, render, styles, humanise };
