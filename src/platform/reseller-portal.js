'use strict';

const crypto = require('crypto');
const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const subscriptions = require('../subscriptions');
const provisioning = require('../jellyfin/provisioning');
const { esc } = require('./admin-html');
const { sendCsv } = require('./export');

function site() {
    return process.env.SITE_NAME || 'CAPTaINFiN';
}

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'reseller') return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function randomPassword() {
    return crypto.randomBytes(12).toString('base64url');
}

async function requireStep(req) {
    return auth.verifySecondFactor(req.session.authUserId, req.body.code, req);
}

async function resolveReseller(userId) {
    const result = await query('SELECT * FROM resellers WHERE user_id=$1', [userId]);
    if (!result.rowCount) throw new Error('This staff account is not linked to a reseller record');
    return result.rows[0];
}

function nav(active) {
    const links = [['dashboard', 'Dashboard', '/reseller'], ['history', 'Credit history', '/reseller/credit-history']];
    return `<nav class="detailTabs">${links.map(([key, label, url]) => `<a class="detailTab ${active === key ? 'active' : ''}" href="${url}">${esc(label)}</a>`).join('')}</nav>`;
}

function shell({ active, title, subtitle = '', body }) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site())}</title><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"></head><body><div class="appShell"><header class="topBar" style="position:static;margin:0"><div><strong>${esc(site())}</strong> · Reseller</div><a class="button secondary btn-sm" href="/logout">Sign out</a></header><main class="mainPane" style="margin-left:0"><div class="content"><div class="pageHeader"><h1>${esc(title)}</h1><div class="muted">${esc(subtitle)}</div></div>${nav(active)}${body}</div></main></div></body></html>`;
}

function csrfInput(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function stepInput() {
    return `<div class="formGroup"><label>Authenticator / recovery code <span class="muted">(only needed if 2FA is enabled)</span></label><input class="input" name="code" autocomplete="one-time-code"></div>`;
}

function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}

function pill(text, kind = '') {
    return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function redirect(res, key, message) {
    return res.redirect('/reseller?' + key + '=' + encodeURIComponent(message));
}

async function resellerPlans(field) {
    const result = await query(`
        SELECT * FROM plans
        WHERE active=TRUE AND audience IN ('reseller','both') AND ${field} IS NOT NULL
        ORDER BY sort_order,name
    `);
    return result.rows;
}

async function listClients(resellerId) {
    const result = await query(`
        SELECT c.id,c.display_name,c.email,c.note,c.created_at,
               s.status AS sub_status,s.current_period_end,p.name AS plan_name,
               ja.jellyfin_username,ja.disabled AS jellyfin_disabled
        FROM customers c
        LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE customer_id=c.id
            ORDER BY current_period_end DESC LIMIT 1
        ) s ON TRUE
        LEFT JOIN plans p ON p.id=s.plan_id
        LEFT JOIN LATERAL (
            SELECT * FROM jellyfin_accounts WHERE customer_id=c.id AND disabled=FALSE
            ORDER BY created_at ASC LIMIT 1
        ) ja ON TRUE
        WHERE c.reseller_id=$1
        ORDER BY c.created_at DESC
    `, [resellerId]);
    return result.rows;
}

function planOptions(plans, costField) {
    return plans.map(p => `<option value="${esc(p.code)}">${esc(p.name)} (${esc(p[costField])} credits/unit)</option>`).join('');
}

function clientCard(req, row, regularOptions, trialOptions) {
    const now = Date.now();
    const end = row.current_period_end ? new Date(row.current_period_end) : null;
    const expiringSoon = end && end.getTime() > now && end.getTime() - now < 3 * 86400000;
    const expired = end && end.getTime() <= now;
    const statusKind = expired ? 'bad' : expiringSoon ? 'warn' : row.sub_status ? 'good' : '';
    return `<div class="serverCard">
        <div class="serverTop">
            <div><strong>${esc(row.display_name || 'Client')}</strong><div class="subText">${esc(row.jellyfin_username || 'No Jellyfin account yet')}</div></div>
            ${pill(row.sub_status ? (expired ? 'expired' : row.sub_status) : 'no plan', statusKind)}
        </div>
        <div class="subText">${esc(row.plan_name || 'No plan')}${end ? ' · until ' + esc(end.toLocaleString()) : ''}</div>
        ${row.note ? `<div class="subText">${esc(row.note)}</div>` : ''}
        <div class="buttonRow">
            <a class="button secondary btn-sm" href="/reseller/client/${esc(row.id)}/credentials">Credentials</a>
        </div>
        <div class="formPanel">
            <form method="post" action="/reseller/trial/extend">
                ${csrfInput(req)}
                <input type="hidden" name="customerId" value="${esc(row.id)}">
                <input type="hidden" name="wallet" value="regular">
                <div class="formGrid">
                    <div class="formGroup"><label>Extend with regular credits</label><select class="input" name="planCode">${regularOptions}</select></div>
                    <div class="formGroup"><label>Units</label><input class="input" type="number" name="units" min="1" max="24" value="1"></div>
                </div>
                ${stepInput()}
                <button class="button secondary btn-sm">Extend (regular)</button>
            </form>
            <form method="post" action="/reseller/trial/extend">
                ${csrfInput(req)}
                <input type="hidden" name="customerId" value="${esc(row.id)}">
                <input type="hidden" name="wallet" value="trial">
                <div class="formGrid">
                    <div class="formGroup"><label>Extend with trial credits</label><select class="input" name="planCode">${trialOptions}</select></div>
                    <div class="formGroup"><label>Units</label><input class="input" type="number" name="units" min="1" max="24" value="1"></div>
                </div>
                ${stepInput()}
                <button class="button secondary btn-sm">Extend (trial)</button>
            </form>
            <form method="post" action="/reseller/client/reset-password">
                ${csrfInput(req)}
                <input type="hidden" name="customerId" value="${esc(row.id)}">
                ${stepInput()}
                <button class="button secondary btn-sm">Reset Jellyfin password</button>
            </form>
            <form method="post" action="/reseller/client/update-note">
                ${csrfInput(req)}
                <input type="hidden" name="customerId" value="${esc(row.id)}">
                <div class="formGroup"><label>Note</label><input class="input" name="note" maxlength="500" value="${esc(row.note || '')}"></div>
                <button class="button secondary btn-sm">Save note</button>
            </form>
            <form method="post" action="/reseller/client/toggle">
                ${csrfInput(req)}
                <input type="hidden" name="customerId" value="${esc(row.id)}">
                ${stepInput()}
                <button class="button btn-danger btn-sm">Suspend access</button>
            </form>
        </div>
    </div>`;
}

async function dashboardBody(req, reseller) {
    const [clients, regularPlans, trialPlans] = await Promise.all([
        listClients(reseller.id),
        resellerPlans('reseller_credit_cost'),
        resellerPlans('reseller_trial_credit_cost')
    ]);
    const regularOptions = planOptions(regularPlans, 'reseller_credit_cost');
    const trialOptions = planOptions(trialPlans, 'reseller_trial_credit_cost');

    const filter = req.query.filter;
    const now = Date.now();
    let rows = clients;
    if (filter === 'expiring') rows = clients.filter(c => c.current_period_end && new Date(c.current_period_end).getTime() > now && new Date(c.current_period_end).getTime() - now < 3 * 86400000);
    if (filter === 'expired') rows = clients.filter(c => c.current_period_end && new Date(c.current_period_end).getTime() <= now);

    return `${notice(req)}
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Regular credits</div><div class="metricValue">${esc(reseller.credits)}</div></div>
            <div class="metric"><div class="metricLabel">Trial credits</div><div class="metricValue">${esc(reseller.trial_credits)}</div></div>
            <div class="metric"><div class="metricLabel">Clients</div><div class="metricValue">${clients.length}</div></div>
        </div>
        <section class="section">
            <div class="sectionHead"><h2>Create client</h2><span class="muted">Costs trial credits · issues a fresh Jellyfin password</span></div>
            ${trialPlans.length ? `<form class="formPanel" method="post" action="/reseller/trial/create">
                ${csrfInput(req)}
                <div class="formGrid">
                    <div class="formGroup"><label>Jellyfin username</label><input class="input" name="username" required pattern="[A-Za-z0-9._-]{3,40}" maxlength="40"></div>
                    <div class="formGroup"><label>Plan</label><select class="input" name="planCode">${trialOptions}</select></div>
                </div>
                ${stepInput()}
                <button class="button">Create trial client</button>
            </form>` : '<div class="empty">No trial-eligible plans are configured yet. Ask an admin to set trial reseller credit costs on a plan.</div>'}
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Clients</h2><div class="buttonRow"><a class="button secondary btn-sm ${!filter ? 'active' : ''}" href="/reseller">All (${clients.length})</a><a class="button secondary btn-sm" href="/reseller?filter=expiring">Expiring soon</a><a class="button secondary btn-sm" href="/reseller?filter=expired">Expired</a><a class="button secondary btn-sm" href="/reseller/export">Export CSV</a></div></div>
            ${rows.length ? `<div class="serverGrid">${rows.map(row => clientCard(req, row, regularOptions, trialOptions)).join('')}</div>` : '<div class="empty">No clients yet.</div>'}
        </section>
        <section class="section">
            <div class="sectionHead"><h2>Content request</h2></div>
            <form class="formPanel" method="post" action="/reseller/content-request">
                ${csrfInput(req)}
                <div class="formGroup"><label>What are you looking for?</label><input class="input" name="requestText" maxlength="500" required></div>
                <button class="button secondary">Send request to admin</button>
            </form>
        </section>`;
}

async function creditHistoryBody(req, reseller) {
    const result = await query('SELECT * FROM credit_transactions WHERE reseller_id=$1 ORDER BY created_at DESC LIMIT 250', [reseller.id]);
    const rows = result.rows;
    return `${notice(req)}<section class="section"><div class="sectionHead"><h2>Credit history</h2><span class="muted">${rows.length} shown</span></div>${rows.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Date</th><th>Amount</th><th>Type</th><th>Note</th></tr></thead><tbody>${rows.map(x => `<tr><td data-label="Date">${esc(new Date(x.created_at).toLocaleString())}</td><td data-label="Amount">${esc(x.amount)}</td><td data-label="Type">${esc(x.transaction_type)}</td><td data-label="Note">${esc(x.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No credit activity yet.</div>'}</section>`;
}

async function credentialsBody(req, reseller, customerId) {
    const client = await query('SELECT * FROM customers WHERE id=$1 AND reseller_id=$2', [customerId, reseller.id]);
    if (!client.rowCount) return null;
    const accounts = await query(`
        SELECT ja.jellyfin_username,ja.disabled,js.name AS server_name,js.public_url
        FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=$1 ORDER BY ja.created_at ASC
    `, [customerId]);
    return `${notice(req)}<section class="section"><div class="sectionHead"><h2>${esc(client.rows[0].display_name)}</h2></div>${accounts.rowCount ? accounts.rows.map(a => `<div class="serverCard"><strong>${esc(a.jellyfin_username)}</strong><div class="subText">${esc(a.server_name)} · ${pill(a.disabled ? 'disabled' : 'enabled', a.disabled ? 'bad' : 'good')}</div>${a.public_url ? `<p><a href="${esc(a.public_url)}" target="_blank" rel="noopener">Open Jellyfin</a></p>` : ''}</div>`).join('') : '<div class="empty">No Jellyfin account yet.</div>'}<div class="securityNote standalone">Passwords are never stored or displayed after creation. Use "Reset Jellyfin password" on the dashboard to issue a new one.</div><a class="button secondary" href="/reseller">Back</a></section>`;
}

async function dashboardPage(req, res, next) {
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        return res.send(shell({ active: 'dashboard', title: 'Reseller dashboard', subtitle: 'Clients, credits and access', body: await dashboardBody(req, reseller) }));
    } catch (error) { return next(error); }
}

function expiringClientsRedirect(req, res) { return res.redirect('/reseller?filter=expiring'); }
function expiredClientsRedirect(req, res) { return res.redirect('/reseller?filter=expired'); }

async function exportClientsCsv(req, res, next) {
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        const rows = await listClients(reseller.id);
        return sendCsv(res, 'clients.csv', [
            { key: 'display_name', label: 'Client' },
            { key: 'jellyfin_username', label: 'Jellyfin username' },
            { key: 'plan_name', label: 'Plan' },
            { key: 'sub_status', label: 'Status' },
            { key: 'current_period_end', label: 'Access until' },
            { key: 'note', label: 'Note' }
        ], rows);
    } catch (error) { return next(error); }
}

async function creditHistoryPage(req, res, next) {
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        return res.send(shell({ active: 'history', title: 'Credit history', body: await creditHistoryBody(req, reseller) }));
    } catch (error) { return next(error); }
}

async function credentialsPage(req, res, next) {
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        const body = await credentialsBody(req, reseller, req.params.id);
        if (body == null) return res.status(404).send('Client not found');
        return res.send(shell({ active: 'dashboard', title: 'Client credentials', body }));
    } catch (error) { return next(error); }
}

async function createTrialClient(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        if (!(await requireStep(req))) throw new Error('verification');
        const username = String(req.body.username || '').trim();
        const planCode = String(req.body.planCode || '').trim();
        if (!planCode) throw new Error('Choose a plan.');

        const { subscription, reconcile, reconcileError } = await subscriptions.createResellerClient({
            resellerId: reseller.id, username, planCode, actorUserId: req.session.authUserId
        });

        if (reconcile?.account?.id) {
            const password = randomPassword();
            await provisioning.setJellyfinPassword(subscription.customer_id, reconcile.account.id, password);
            const body = `<div class="notice success">Client created.</div><section class="section"><div class="formPanel"><p><strong>Username:</strong> ${esc(username)}</p><p><strong>Password:</strong></p><div class="codeBox">${esc(password)}</div><p class="muted">Shown once. Share it securely.</p><a class="button" href="/reseller">Back</a></div></section>`;
            return res.send(shell({ active: 'dashboard', title: 'Client created', body }));
        }
        const note = reconcileError
            ? 'Client created and credits were charged, but Jellyfin provisioning is still catching up. It will finish automatically within a few minutes -- use "Reset Jellyfin password" once it does.'
            : 'Client created. Use "Reset Jellyfin password" to issue credentials.';
        return redirect(res, 'message', note);
    } catch (error) {
        console.error('Reseller trial create failed:', error.message);
        return redirect(res, 'error', error.message === 'verification' ? 'Verification failed.' : error.message);
    }
}

async function extendClient(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        if (!(await requireStep(req))) throw new Error('verification');
        const client = await query('SELECT id FROM customers WHERE id=$1 AND reseller_id=$2', [req.body.customerId, reseller.id]);
        if (!client.rowCount) throw new Error('Client not found');
        const wallet = req.body.wallet === 'trial' ? 'trial' : 'regular';
        const units = Number.parseInt(req.body.units, 10) || 1;
        await subscriptions.extendWithResellerCredits({
            resellerId: reseller.id, customerId: req.body.customerId, planCode: req.body.planCode, units, wallet, actorUserId: req.session.authUserId
        });
        return redirect(res, 'message', 'Client extended.');
    } catch (error) {
        return redirect(res, 'error', error.message === 'verification' ? 'Verification failed.' : error.message);
    }
}

async function resetClientPassword(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        if (!(await requireStep(req))) throw new Error('verification');
        const client = await query('SELECT id FROM customers WHERE id=$1 AND reseller_id=$2', [req.body.customerId, reseller.id]);
        if (!client.rowCount) throw new Error('Client not found');
        const account = await query("SELECT id FROM jellyfin_accounts WHERE customer_id=$1 AND disabled=FALSE ORDER BY created_at ASC LIMIT 1", [req.body.customerId]);
        if (!account.rowCount) throw new Error('This client has no active Jellyfin account yet.');
        const password = randomPassword();
        await provisioning.setJellyfinPassword(req.body.customerId, account.rows[0].id, password);
        const body = `<div class="notice success">Password reset.</div><section class="section"><div class="formPanel"><p><strong>New password:</strong></p><div class="codeBox">${esc(password)}</div><p class="muted">Shown once. Share it securely.</p><a class="button" href="/reseller">Back</a></div></section>`;
        return res.send(shell({ active: 'dashboard', title: 'Password reset', body }));
    } catch (error) {
        return redirect(res, 'error', error.message === 'verification' ? 'Verification failed.' : error.message);
    }
}

async function updateClientNote(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        const note = String(req.body.note || '').trim().slice(0, 500);
        const updated = await query('UPDATE customers SET note=$1 WHERE id=$2 AND reseller_id=$3', [note, req.body.customerId, reseller.id]);
        if (!updated.rowCount) throw new Error('Client not found');
        return redirect(res, 'message', 'Note saved.');
    } catch (error) {
        return redirect(res, 'error', 'Could not save note.');
    }
}

async function toggleClient(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        if (!(await requireStep(req))) throw new Error('verification');
        const client = await query('SELECT id FROM customers WHERE id=$1 AND reseller_id=$2', [req.body.customerId, reseller.id]);
        if (!client.rowCount) throw new Error('Client not found');
        await query(`
            UPDATE subscriptions SET status='cancelled',updated_at=NOW()
            WHERE customer_id=$1 AND status IN ('active','trialing','past_due')
        `, [req.body.customerId]);
        await provisioning.reconcileCustomer(req.body.customerId);
        return redirect(res, 'message', 'Access suspended. Extend the client to restore it.');
    } catch (error) {
        return redirect(res, 'error', error.message === 'verification' ? 'Verification failed.' : 'Could not suspend client.');
    }
}

async function deleteClientStub(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    return redirect(res, 'error', 'Deleting clients is not available yet. Suspend access instead.');
}

async function contentRequest(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
        const reseller = await resolveReseller(req.session.authUserId);
        const text = String(req.body.requestText || '').trim().slice(0, 500);
        if (!text) throw new Error('Enter a request.');
        await query("INSERT INTO content_requests(reseller_id,media_type,request_text) VALUES($1,'other',$2)", [reseller.id, text]);
        return redirect(res, 'message', 'Request sent to admin.');
    } catch (error) {
        return redirect(res, 'error', error.message);
    }
}

function messageReadStub(req, res) {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    return redirect(res, 'message', 'Noted.');
}

function portalErrorHandler(error, _req, res, _next) {
    console.error('Reseller portal error:', error.message);
    return res.status(500).send('The reseller portal could not load safely.');
}

function createResellerPortalRouter() {
    const router = express.Router();
    router.use('/reseller', gate, noStore);
    router.get('/reseller', dashboardPage);
    router.get('/reseller/expiring-clients', expiringClientsRedirect);
    router.get('/reseller/expired-clients', expiredClientsRedirect);
    router.get('/reseller/export', exportClientsCsv);
    router.get('/reseller/credit-history', creditHistoryPage);
    router.get('/reseller/client/:id/credentials', credentialsPage);
    router.post('/reseller/trial/create', createTrialClient);
    router.post('/reseller/trial/extend', extendClient);
    router.post('/reseller/client/reset-password', resetClientPassword);
    router.post('/reseller/client/update-note', updateClientNote);
    router.post('/reseller/client/toggle', toggleClient);
    router.post('/reseller/client/delete', deleteClientStub);
    router.post('/reseller/content-request', contentRequest);
    router.post('/reseller/message/read', messageReadStub);
    router.use('/reseller', portalErrorHandler);
    return router;
}

module.exports = {
    createResellerPortalRouter,
    gate,
    noStore,
    dashboardPage,
    expiringClientsRedirect,
    expiredClientsRedirect,
    exportClientsCsv,
    creditHistoryPage,
    credentialsPage,
    createTrialClient,
    extendClient,
    resetClientPassword,
    updateClientNote,
    toggleClient,
    deleteClientStub,
    contentRequest,
    messageReadStub
};
