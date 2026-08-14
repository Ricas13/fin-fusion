'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const drift = require('../jellyfin/drift-control');
const provisioning = require('../jellyfin/resilient-provisioning');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function pill(label, cls = '') { return `<span class="pill ${cls}">${esc(label)}</span>`; }
function statusPill(status) {
    if (status === 'in_sync') return pill('In sync', 'good');
    if (status === 'drift') return pill('Drift', 'warn');
    if (status === 'missing') return pill('Missing', 'bad');
    if (status === 'unreachable') return pill('Unreachable', 'bad');
    return pill('Unknown');
}

const FIELD_LABELS = {
    Username: 'Username',
    IsAdministrator: 'Administrator',
    IsHidden: 'Hidden user',
    IsDisabled: 'Account disabled',
    EnableAllDevices: 'All devices',
    EnableAllFolders: 'All libraries',
    EnabledFolders: 'Libraries',
    EnableAllChannels: 'All channels',
    EnableRemoteAccess: 'Remote access',
    EnableMediaPlayback: 'Media playback',
    EnableAudioPlaybackTranscoding: 'Audio transcoding',
    EnableVideoPlaybackTranscoding: 'Video transcoding',
    EnablePlaybackRemuxing: 'Remux / direct stream',
    EnableContentDownloading: 'Downloads',
    EnableSyncTranscoding: 'Sync transcoding',
    EnableMediaConversion: 'Media conversion',
    EnableContentDeletion: 'Content deletion',
    EnableRemoteControlOfOtherUsers: 'Remote-control other users',
    EnableSharedDeviceControl: 'Shared-device control',
    EnableLiveTvManagement: 'Live TV management',
    EnableLiveTvAccess: 'Live TV access',
    EnableUserPreferenceAccess: 'User preferences',
    SyncPlayAccess: 'SyncPlay',
    MissingLibraries: 'Missing server libraries'
};

function compactValue(value) {
    if (Array.isArray(value)) {
        if (!value.length) return 'none';
        if (value.length <= 3) return value.join(', ');
        return `${value.slice(0, 3).join(', ')} +${value.length - 3}`;
    }
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (value == null || value === '') return 'none';
    return String(value);
}

function differenceDetails(row) {
    const differences = Array.isArray(row.differences) ? row.differences : [];
    if (!differences.length) return '<span class="muted">—</span>';
    const summary = differences.slice(0, 3).map(diff => FIELD_LABELS[diff.field] || diff.field).join(', ');
    const more = differences.length > 3 ? ` +${differences.length - 3}` : '';
    return `<details class="driftDetails"><summary>${esc(summary + more)}</summary><div class="driftDifferenceList">${differences.map(diff => {
        const label = FIELD_LABELS[diff.field] || diff.field;
        return `<div class="driftDifference"><strong>${esc(label)}</strong><span><b>Expected:</b> ${esc(compactValue(diff.expected))}</span><span><b>Jellyfin:</b> ${esc(compactValue(diff.actual))}</span></div>`;
    }).join('')}</div></details>`;
}

function rowActions(req, row) {
    const actions = [`<form method="post" action="/admin/provisioning/drift/${esc(row.jellyfin_account_id)}/audit">${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Audit now</button></form>`];
    if (['drift','missing'].includes(row.status)) {
        actions.push(`<form method="post" action="/admin/provisioning/drift/${esc(row.customer_id)}/reconcile" data-confirm="Reapply CAPTaINFiN's desired Jellyfin policy for this customer?">${csrfInput(req)}<button class="button btn-sm" type="submit">Reconcile</button></form>`);
    }
    return `<div class="driftActions">${actions.join('')}</div>`;
}

function accountRow(req, row) {
    const identity = row.portal_username || row.display_name || row.email || 'Customer';
    const desired = row.desired_disabled === true
        ? `<strong>Disabled</strong><div class="subText">No active entitlement on this account</div>`
        : row.desired_disabled === false
            ? `<strong>Enabled</strong><div class="subText">${esc(row.plan_name || 'Active entitlement')}</div>`
            : '<span class="muted">Not evaluated yet</span>';
    const problem = row.last_error ? `<div class="errorText">${esc(row.last_error)}</div>` : '';
    return `<tr>
        <td>${statusPill(row.status)}${problem}</td>
        <td><strong>${esc(identity)}</strong><div class="subText">${esc(row.email || row.customer_id)}</div></td>
        <td><strong>${esc(row.jellyfin_username)}</strong><div class="subText">${esc(row.server_name)} · ${esc(row.health_status || 'unknown')}</div></td>
        <td>${desired}</td>
        <td>${differenceDetails(row)}</td>
        <td>${esc(date(row.last_checked_at))}${row.last_success_at ? `<div class="subText">Last successful read ${esc(date(row.last_success_at))}</div>` : ''}</td>
        <td>${esc(date(row.next_check_at))}</td>
        <td class="right">${rowActions(req,row)}</td>
    </tr>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [rows, stats] = await Promise.all([drift.listAuditRows(), drift.stats()]);
    const cards = [
        ['Managed accounts', stats.total || 0],
        ['In sync', stats.in_sync || 0],
        ['Drift', stats.drift || 0],
        ['Unreachable', stats.unreachable || 0],
        ['Missing', stats.missing || 0],
        ['Unknown', stats.unknown || 0]
    ];
    const body = `${notice(req)}
        <div class="metrics">${cards.map(([label,value]) => `<div class="metric"><div class="metricLabel">${esc(label)}</div><div class="metricValue smallish">${Number(value).toLocaleString('en-GB')}</div></div>`).join('')}</div>
        <section class="section"><div class="sectionHead"><div><h2>Remote Jellyfin compliance</h2><div class="muted">Read-only audits compare CAPTaINFiN's desired account policy with the live Jellyfin user record.</div></div><div class="driftToolbar"><a class="button secondary" href="/admin/provisioning">Back to Provisioning</a><form method="post" action="/admin/provisioning/drift/audit-due">${csrfInput(req)}<button class="button secondary">Audit due</button></form><form method="post" action="/admin/provisioning/drift/audit-all" data-confirm="Read every managed Jellyfin account now? This does not change Jellyfin, but it can generate substantial API traffic on a large fleet.">${csrfInput(req)}<button class="button">Audit all</button></form></div></div>
            <div class="notice">Auditing never changes Jellyfin. Only the explicit <strong>Reconcile</strong> action reapplies CAPTaINFiN policy. Unreachable servers are retried with backoff and do not get treated as compliant or non-compliant.</div>
            ${rows.length ? `<div class="tableWrap"><table class="dataTable driftTable"><thead><tr><th>Status</th><th>Customer</th><th>Jellyfin account</th><th>Desired state</th><th>Differences</th><th>Last checked</th><th>Next check</th><th class="right">Actions</th></tr></thead><tbody>${rows.map(row => accountRow(req,row)).join('')}</tbody></table></div>` : '<div class="empty">No managed Jellyfin accounts exist yet.</div>'}
        </section>
        <style>.driftTable{min-width:1450px}.driftToolbar,.driftActions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.driftToolbar form,.driftActions form{margin:0}.driftDetails summary{cursor:pointer;color:#c8d4df}.driftDifferenceList{display:grid;gap:8px;margin-top:8px;min-width:300px}.driftDifference{display:grid;gap:2px;padding:7px 8px;border:1px solid #2d3743;border-radius:6px;background:#10161d}.driftDifference span{font-size:10px;color:#9aa7b6;word-break:break-word}.errorText{font-size:10px;color:#ef9298;max-width:280px;margin-top:4px}.metricValue.smallish{font-size:22px}</style>
        <script>(function(){document.querySelectorAll('[data-confirm]').forEach(function(form){form.addEventListener('submit',function(event){if(!window.confirm(form.getAttribute('data-confirm')))event.preventDefault()})})})();</script>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'provisioning', title: 'Policy Drift', subtitle: 'Detect out-of-band changes to CAPTaINFiN-managed Jellyfin accounts', body });
}

function createAdminDriftRouter() {
    const router = express.Router();
    router.use('/admin/provisioning/drift', gate, noStore);
    router.get('/admin/provisioning/drift', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/provisioning/drift/audit-due', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await drift.auditDue({ all: false, limit: 200 });
            return res.redirect('/admin/provisioning/drift?message=' + encodeURIComponent(`Audit complete: ${result.inSync} in sync, ${result.drift} drift, ${result.missing} missing, ${result.unreachable} unreachable.`));
        } catch (error) {
            return res.redirect('/admin/provisioning/drift?error=' + encodeURIComponent(error.message || 'Policy audit failed.'));
        }
    });
    router.post('/admin/provisioning/drift/audit-all', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await drift.auditDue({ all: true, limit: 1000 });
            return res.redirect('/admin/provisioning/drift?message=' + encodeURIComponent(`Full audit complete: ${result.inSync} in sync, ${result.drift} drift, ${result.missing} missing, ${result.unreachable} unreachable.`));
        } catch (error) {
            return res.redirect('/admin/provisioning/drift?error=' + encodeURIComponent(error.message || 'Policy audit failed.'));
        }
    });
    router.post('/admin/provisioning/drift/:accountId/audit', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await drift.auditAccount(req.params.accountId);
            return res.redirect('/admin/provisioning/drift?message=' + encodeURIComponent(`Account audit finished: ${result.status.replace('_',' ')}.`));
        } catch (error) {
            return res.redirect('/admin/provisioning/drift?error=' + encodeURIComponent(error.message || 'Account audit failed.'));
        }
    });
    router.post('/admin/provisioning/drift/:customerId/reconcile', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await provisioning.control.forceCustomerDue(req.params.customerId);
            await provisioning.reconcileCustomer(req.params.customerId);
            await drift.clearForCustomer(req.params.customerId);
            return res.redirect('/admin/provisioning/drift?message=' + encodeURIComponent('CAPTaINFiN policy reapplied. The customer is queued for a fresh remote compliance audit.'));
        } catch (error) {
            return res.redirect('/admin/provisioning/drift?error=' + encodeURIComponent(error.message || 'Reconciliation failed.'));
        }
    });
    return router;
}

module.exports = { createAdminDriftRouter, page, accountRow, differenceDetails };
