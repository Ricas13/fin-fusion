'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const importer = require('../jellyfin/user-import');
const registry = require('../jellyfin/registry');
const { layout, esc } = require('./admin-html');

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
function checked(value) { return value === 'on' || value === '1' || value === true; }
function dt(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function pill(label, kind = '') { return `<span class="pill ${kind}">${esc(label)}</span>`; }

async function planOptions() {
    const result = await query(`
        SELECT id,name,code,server_class,billing_interval,duration_days
        FROM plans
        WHERE active=TRUE
          AND visible=TRUE
          AND archived_at IS NULL
          AND audience IN ('direct','both')
          AND (effective_from IS NULL OR effective_from<=NOW())
          AND (effective_until IS NULL OR effective_until>NOW())
        ORDER BY sort_order,name
    `);
    return result.rows;
}

function statusCell(row) {
    if (row.import_status === 'managed') {
        return `${pill('Managed', 'good')}<div class="planMeta"><a href="/admin/users/${esc(row.managed.customer_id)}">${esc(row.managed.customer_name || 'Customer')}</a>${row.managed.plan_name ? ` · ${esc(row.managed.plan_name)}` : ''}</div>`;
    }
    if (row.import_status === 'identity_drift') {
        return `${pill('ID changed', 'warn')}<div class="planMeta">Managed as ${esc(row.managed.customer_name || row.managed.jellyfin_username)}</div>`;
    }
    if (row.import_status === 'administrator') return `${pill('Administrator', 'bad')}<div class="planMeta">Protected from customer import</div>`;
    return `${pill('Unmanaged')}<div class="planMeta">Available to import or link</div>`;
}

function accountFlags(row) {
    const flags = [];
    flags.push(row.disabled ? pill('Disabled', 'warn') : pill('Enabled', 'good'));
    if (row.hidden) flags.push(pill('Hidden'));
    if (row.has_password) flags.push(pill('Password set'));
    return flags.join(' ');
}

function rowHtml(req, row) {
    const key = `${row.server_id}:${row.jellyfin_user_id}`;
    const selectable = row.import_status === 'unmanaged';
    const actions = [];
    if (row.import_status === 'unmanaged') {
        actions.push(`<a class="button secondary btn-sm" href="/admin/jellyfin-import/link?serverId=${encodeURIComponent(row.server_id)}&userId=${encodeURIComponent(row.jellyfin_user_id)}">Link existing</a>`);
    }
    if (row.import_status === 'identity_drift') {
        actions.push(`<form method="post" action="/admin/jellyfin-import/rebind" class="inlineForm">${csrfInput(req)}<input type="hidden" name="serverId" value="${esc(row.server_id)}"><input type="hidden" name="userId" value="${esc(row.jellyfin_user_id)}"><button class="button secondary btn-sm" type="submit">Rebind ID</button></form>`);
    }
    return `<tr>
        <td>${selectable ? `<input class="importCheck" type="checkbox" name="selected" value="${esc(key)}">` : ''}</td>
        <td><strong>${esc(row.jellyfin_username)}</strong><div class="planMeta">${esc(row.jellyfin_user_id)}</div></td>
        <td>${esc(row.server_name)}<div class="planMeta">${esc(row.server_class)}</div></td>
        <td>${accountFlags(row)}</td>
        <td>${esc(dt(row.last_activity_at || row.last_login_at))}</td>
        <td>${statusCell(row)}</td>
        <td class="right"><div class="buttonRow compactButtons">${actions.join('')}</div></td>
    </tr>`;
}

function planSelect(plans) {
    return `<select class="input" name="planId"><option value="">No plan — inventory/link only</option>${plans.map(plan => `<option value="${esc(plan.id)}">${esc(plan.name)} · ${esc(plan.server_class)} · ${esc(plan.billing_interval)}</option>`).join('')}</select>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const serverId = req.query.serverId || null;
    const [discovery, plans, allServers] = await Promise.all([
        importer.discover({ serverId }),
        planOptions(),
        registry.listServers({ enabledOnly: true })
    ]);
    const rows = discovery.rows;
    const counts = {
        total: rows.length,
        unmanaged: rows.filter(row => row.import_status === 'unmanaged').length,
        managed: rows.filter(row => row.import_status === 'managed').length,
        drift: rows.filter(row => row.import_status === 'identity_drift').length,
        admins: rows.filter(row => row.import_status === 'administrator').length
    };
    const serverSelect = `<form method="get" action="/admin/jellyfin-import" class="formPanel compactPanel"><div class="formGrid"><div class="formGroup"><label>Jellyfin server</label><select class="input" name="serverId"><option value="">All enabled servers</option>${allServers.map(server => `<option value="${esc(server.id)}" ${String(server.id) === String(serverId) ? 'selected' : ''}>${esc(server.name)} · ${esc(server.server_class)}</option>`).join('')}</select></div></div><div class="buttonRow"><button class="button secondary">Scan users</button></div></form>`;
    const failureNotice = discovery.failures.length ? `<div class="notice error"><strong>${discovery.failures.length} server scan${discovery.failures.length === 1 ? '' : 's'} failed.</strong><div class="planMeta">${discovery.failures.map(item => `${esc(item.serverName)}: ${esc(item.error)}`).join('<br>')}</div></div>` : '';
    const metrics = `<div class="metrics"><div class="metric"><div class="metricLabel">Discovered</div><div class="metricValue smallish">${counts.total}</div></div><div class="metric"><div class="metricLabel">Unmanaged</div><div class="metricValue smallish">${counts.unmanaged}</div></div><div class="metric"><div class="metricLabel">Already managed</div><div class="metricValue smallish">${counts.managed}</div></div><div class="metric"><div class="metricLabel">ID changes</div><div class="metricValue smallish">${counts.drift}</div></div><div class="metric"><div class="metricLabel">Admins protected</div><div class="metricValue smallish">${counts.admins}</div></div></div>`;
    const safety = `<section class="card"><div class="card-header"><div><h2 class="card-title">Safe adoption of existing accounts</h2><div class="muted">Import links CAPTAiNFiN to the Jellyfin account that already exists. It never recreates that Jellyfin user and never reads or resets their password.</div></div></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">Create customer</div><div class="compact-meta">Creates a CAPTAiNFiN customer record and adopts the selected Jellyfin identity. Portal login remains unclaimed until you create/claim one separately.</div></div></div><div class="compact-item"><div><div class="compact-title">Optional plan</div><div class="compact-meta">Assign a current plan and migration subscription during import, or leave the plan blank for inventory-only adoption.</div></div></div><div class="compact-item"><div><div class="compact-title">Policy is opt-in</div><div class="compact-meta">By default the import does not touch Jellyfin policy. Tick Apply plan policy now only when you want CAPTAiNFiN to immediately enforce the selected plan.</div></div></div></div></section>`;
    const bulk = counts.unmanaged ? `<section class="section"><div class="sectionHead"><div><h2>Import selected users</h2><div class="muted">Use one plan for this batch. Run separate batches when Free/Premium users need different plans.</div></div></div><form id="importForm" method="post" action="/admin/jellyfin-import/bulk" class="formPanel">${csrfInput(req)}<div class="formGrid"><div class="formGroup"><label>Plan</label>${planSelect(plans)}<div class="inlineHelp">Blank means no subscription is created.</div></div><div class="formGroup"><label>Expiry override (optional)</label><input class="input" type="date" name="expiresAt"><div class="inlineHelp">Blank uses the plan duration from today.</div></div></div><label class="toggleRow"><input type="checkbox" name="applyPolicy"><span>Apply selected plan policy immediately after each import</span></label><div class="buttonRow"><button class="button" type="submit">Import selected</button><button class="button secondary" type="button" id="selectAllImports">Select all unmanaged</button></div></form></section>` : '';
    const table = `<section class="section"><div class="sectionHead"><div><h2>Jellyfin users</h2><div class="muted">Discovery is read-only. Jellyfin administrators cannot be imported.</div></div><span class="muted">${rows.length} shown</span></div>${rows.length ? `<div class="tableWrap"><table class="dataTable importTable"><thead><tr><th></th><th>User</th><th>Server</th><th>Jellyfin</th><th>Last activity</th><th>CAPTAiNFiN</th><th class="right">Action</th></tr></thead><tbody>${rows.map(row => rowHtml(req, row)).join('')}</tbody></table></div>` : '<div class="empty">No Jellyfin users were returned by the selected server(s).</div>'}</section>`;
    const script = '<script src="/js/admin-jellyfin-import.js" defer></script>';
    const styles = '<style>.importTable{min-width:1120px}.metricValue.smallish{font-size:22px}.compactButtons{justify-content:flex-end}.compactButtons form{margin:0}.inlineForm{display:inline}.compactPanel{margin-bottom:16px}</style>';
    return layout({ siteName: runtimeSettings.siteName(), active: 'jellyfin-import', title: 'Import Jellyfin Users', subtitle: 'Adopt existing Jellyfin accounts without recreating users or changing passwords', body: `${styles}${notice(req)}${failureNotice}${serverSelect}${metrics}${safety}${bulk}${table}${script}` });
}

async function linkPage(req) {
    await runtimeSettings.ensureLoaded();
    const serverId = String(req.query.serverId || '');
    const userId = String(req.query.userId || '');
    const q = String(req.query.q || '').trim().slice(0, 80);
    const [{ server, user }, customers] = await Promise.all([
        importer.getRemoteUser(serverId, userId),
        importer.searchCustomers(q, 50)
    ]);
    if (user.administrator) throw new Error('Jellyfin administrator accounts cannot be linked to customers.');
    const search = `<form method="get" action="/admin/jellyfin-import/link" class="formPanel"><input type="hidden" name="serverId" value="${esc(server.id)}"><input type="hidden" name="userId" value="${esc(user.jellyfin_user_id)}"><div class="formGrid"><div class="formGroup"><label>Find customer</label><input class="input" name="q" value="${esc(q)}" placeholder="Name, username or email"></div></div><button class="button secondary">Search</button></form>`;
    const options = customers.map(customer => `<option value="${esc(customer.id)}">${esc(customer.name)}${customer.portal_username ? ` · ${esc(customer.portal_username)}` : ''}${customer.email ? ` · ${esc(customer.email)}` : ''} · ${esc(customer.jellyfin_accounts)} Jellyfin</option>`).join('');
    const form = customers.length ? `<form method="post" action="/admin/jellyfin-import/link" class="formPanel">${csrfInput(req)}<input type="hidden" name="serverId" value="${esc(server.id)}"><input type="hidden" name="userId" value="${esc(user.jellyfin_user_id)}"><div class="formGroup"><label>Existing customer</label><select class="input" name="customerId" required>${options}</select></div><label class="toggleRow"><input type="checkbox" name="makePrimary" checked><span>Make this the customer's primary Jellyfin account</span></label><label class="toggleRow"><input type="checkbox" name="applyPolicy"><span>Apply the customer's current plan policy after linking</span></label><div class="buttonRow"><button class="button">Link account</button><a class="button secondary" href="/admin/jellyfin-import">Cancel</a></div></form>` : '<div class="empty">No customers match this search.</div>';
    const body = `${notice(req)}<section class="card"><div class="card-header"><div><h2 class="card-title">${esc(user.jellyfin_username)}</h2><div class="muted">${esc(server.name)} · existing Jellyfin ID ${esc(user.jellyfin_user_id)}</div></div></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">Jellyfin password</div><div class="compact-meta">Unchanged. Linking only records ownership inside CAPTAiNFiN.</div></div>${pill('Preserved', 'good')}</div></div></section>${search}${form}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'jellyfin-import', title: 'Link Existing Jellyfin User', subtitle: 'Attach this existing Jellyfin identity to a customer already managed by CAPTAiNFiN', body });
}

function createAdminJellyfinImportRouter() {
    const router = express.Router();
    router.use('/admin/jellyfin-import', gate, noStore);
    router.get('/admin/jellyfin-import', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.get('/admin/jellyfin-import/link', async (req, res, next) => {
        try { return res.send(await linkPage(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/jellyfin-import/bulk', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await importer.bulkImport({
                selected: req.body.selected,
                planId: req.body.planId || null,
                expiresAt: req.body.expiresAt || null,
                applyPolicy: checked(req.body.applyPolicy),
                actorUserId: req.session.authUserId
            });
            const failed = result.results.filter(item => !item.ok).slice(0, 3).map(item => item.error);
            const message = `${result.imported} Jellyfin user${result.imported === 1 ? '' : 's'} imported${result.failed ? `; ${result.failed} failed` : ''}.`;
            const suffix = failed.length ? '&error=' + encodeURIComponent(failed.join(' | ')) : '';
            return res.redirect('/admin/jellyfin-import?message=' + encodeURIComponent(message) + suffix);
        } catch (error) {
            return res.redirect('/admin/jellyfin-import?error=' + encodeURIComponent(error.message || 'Jellyfin import failed.'));
        }
    });
    router.post('/admin/jellyfin-import/link', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await importer.linkExistingCustomer({
                customerId: req.body.customerId,
                serverId: req.body.serverId,
                jellyfinUserId: req.body.userId,
                makePrimary: checked(req.body.makePrimary),
                applyPolicy: checked(req.body.applyPolicy),
                actorUserId: req.session.authUserId
            });
            return res.redirect('/admin/jellyfin-import?message=' + encodeURIComponent('Existing Jellyfin user linked to customer.'));
        } catch (error) {
            return res.redirect('/admin/jellyfin-import/link?serverId=' + encodeURIComponent(req.body.serverId || '') + '&userId=' + encodeURIComponent(req.body.userId || '') + '&error=' + encodeURIComponent(error.message || 'Link failed.'));
        }
    });
    router.post('/admin/jellyfin-import/rebind', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await importer.rebindIdentity({ serverId: req.body.serverId, jellyfinUserId: req.body.userId, actorUserId: req.session.authUserId });
            return res.redirect('/admin/jellyfin-import?message=' + encodeURIComponent('Managed Jellyfin identity rebound to the server\'s current user ID.'));
        } catch (error) {
            return res.redirect('/admin/jellyfin-import?error=' + encodeURIComponent(error.message || 'Rebind failed.'));
        }
    });
    return router;
}

module.exports = { createAdminJellyfinImportRouter, page, linkPage };