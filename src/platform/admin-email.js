'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const emailSettings = require('../integrations/email-settings');
const outbox = require('../integrations/email-outbox');
const runtimeSettings = require('./runtime-settings');
const integrationCard = require('./admin-integration-card');
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
function deliveryPill(status) {
    if (status === 'sent') return pill('Sent', 'good');
    if (status === 'failed') return pill('Failed', 'bad');
    if (status === 'sending') return pill('Sending', 'accent');
    return pill('Pending');
}
function emailHealthCard(req, settings, recent, counts) {
    const failed = Number(counts.failed || 0);
    const latestSent = (recent || []).find(row => row.status === 'sent');
    let statusLabel = 'Disabled', statusKind = '', workingLabel = 'Disabled', workingKind = '', fixHint = 'Enable the email gateway and complete the SMTP fields below.';
    if (settings.enabled && !settings.configured) {
        statusLabel = 'Incomplete'; statusKind = 'warn'; workingLabel = 'Setup incomplete'; workingKind = 'warn';
        fixHint = settings.error || 'Complete the SMTP host, sender and authentication settings, then test the connection.';
    } else if (settings.configured && failed > 0) {
        statusLabel = 'Needs attention'; statusKind = 'warn'; workingLabel = `${failed} failed message${failed === 1 ? '' : 's'}`; workingKind = 'warn';
        fixHint = 'Review the failed delivery rows below, test SMTP, then retry the affected messages.';
    } else if (settings.configured && latestSent) {
        statusLabel = 'Connected'; statusKind = 'good'; workingLabel = 'Delivery observed'; workingKind = 'good';
        fixHint = 'If delivery stops, test the SMTP connection and review failed queue items below.';
    } else if (settings.configured) {
        statusLabel = 'Configured'; statusKind = 'good'; workingLabel = 'Ready; no delivery observed yet'; workingKind = '';
        fixHint = 'Use Test connection or Send test email to verify the configured SMTP gateway.';
    }
    const actions = `<form method="post" action="/admin/notifications/email/test">${csrfInput(req)}<button class="button secondary btn-sm" type="submit" ${settings.configured ? '' : 'disabled'}>Test connection</button></form><a class="button secondary btn-sm" href="#email-gateway">Manage</a>`;
    return integrationCard.renderIntegrationCard({
        name: 'Email',
        statusLabel,
        statusKind,
        summary: settings.source === 'browser' ? 'Browser-managed transactional SMTP gateway.' : 'Transactional SMTP using environment configuration.',
        enabled: settings.enabled,
        configured: settings.configured,
        workingLabel,
        workingKind,
        lastVerifiedAt: latestSent?.sent_at || latestSent?.last_attempt_at || null,
        lastVerifiedLabel: 'Last successful delivery',
        fixHint,
        actionsHtml: actions
    });
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [settings, recent, counts] = await Promise.all([emailSettings.status(), outbox.recent(100), outbox.counts()]);
    const state = settings.configured ? pill('Ready', 'good') : settings.enabled ? pill('Incomplete', 'warn') : pill('Disabled');
    const source = settings.source === 'browser' ? 'Browser settings' : 'Environment fallback';
    const defaultPort = settings.port || (settings.secureMode === 'tls' ? 465 : 587);
    const body = `${integrationCard.styles()}${notice(req)}
        <section class="section"><div class="sectionHead"><div><h2>Integration status</h2><div class="muted">Configuration, observed delivery and the quickest recovery action in one place.</div></div></div><div class="integrationCardGrid">${emailHealthCard(req, settings, recent, counts)}</div></section>
        <div class="metrics"><div class="metric"><div class="metricLabel">Pending</div><div class="metricValue smallish">${Number(counts.pending || 0)}</div></div><div class="metric"><div class="metricLabel">Failed</div><div class="metricValue smallish">${Number(counts.failed || 0)}</div></div><div class="metric"><div class="metricLabel">Sent</div><div class="metricValue smallish">${Number(counts.sent || 0)}</div></div></div>
        <section class="section" id="email-gateway"><div class="sectionHead"><div><h2>Email gateway</h2><div class="muted">Transactional customer email with an encrypted browser-managed SMTP password and environment fallback.</div></div><div>${state} <span class="muted">${esc(source)}</span></div></div>
            <form class="formPanel emailSettings" method="post" action="/admin/notifications/email/settings" data-native-submit="true">${csrfInput(req)}
                <label class="toggleRow full"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}><span><strong>Enable transactional email</strong><small>Email verification, password reset and other queued customer messages can be delivered.</small></span></label>
                <label><span>SMTP host</span><input class="input" name="host" maxlength="255" required value="${esc(settings.host || '')}" placeholder="smtp.example.com"></label>
                <label><span>Port</span><input class="input" type="number" min="1" max="65535" name="port" required value="${esc(defaultPort)}"></label>
                <label><span>Security</span><select class="input" name="secureMode"><option value="starttls" ${settings.secureMode === 'starttls' ? 'selected' : ''}>STARTTLS (usually 587)</option><option value="tls" ${settings.secureMode === 'tls' ? 'selected' : ''}>TLS from connect (usually 465)</option><option value="plain" ${settings.secureMode === 'plain' ? 'selected' : ''}>Plain SMTP — unauthenticated relay only</option></select><small>Username/password authentication requires STARTTLS or TLS.</small></label>
                <label><span>Username</span><input class="input" name="username" maxlength="300" autocomplete="off" value="${esc(settings.source === 'browser' && settings.usernameConfigured ? '••••••••' : '')}" placeholder="SMTP username"><small>Leave the placeholder unchanged to keep the saved username; replace it to change it.</small></label>
                <label><span>Password</span><input class="input" type="password" name="password" maxlength="500" autocomplete="new-password" placeholder="${settings.passwordConfigured ? 'Saved — leave blank to keep' : 'SMTP password'}"><small>${settings.passwordConfigured ? 'A password is stored encrypted.' : 'No browser password is stored.'}</small></label>
                <label><span>From name</span><input class="input" name="fromName" maxlength="120" value="${esc(settings.fromName || runtimeSettings.siteName())}"></label>
                <label><span>From email</span><input class="input" type="email" name="fromEmail" maxlength="254" required value="${esc(settings.fromEmail || '')}" placeholder="support@example.com"></label>
                <label><span>Reply-to</span><input class="input" type="email" name="replyTo" maxlength="254" value="${esc(settings.replyTo || '')}" placeholder="Optional"></label>
                <label class="toggleRow full"><input type="checkbox" name="clearPassword"><span>Clear saved password</span></label>
                <div class="buttonRow full"><button class="button" type="submit">Save email gateway</button>${settings.source === 'browser' ? `<button class="button secondary" name="useEnvironment" value="1" type="submit">Use environment fallback</button>` : ''}</div>
            </form>
            <div class="gatewayActions"><form method="post" action="/admin/notifications/email/test">${csrfInput(req)}<button class="button secondary" type="submit" ${settings.configured ? '' : 'disabled'}>Test connection</button></form><form method="post" action="/admin/notifications/email/send-test" class="testMail">${csrfInput(req)}<input class="input" type="email" name="to" required placeholder="Send test email to…"><button class="button secondary" ${settings.configured ? '' : 'disabled'}>Send test email</button></form><form method="post" action="/admin/notifications/email/deliver">${csrfInput(req)}<button class="button secondary" type="submit" ${settings.configured ? '' : 'disabled'}>Deliver pending now</button></form></div>
        </section>
        <section class="section"><div class="sectionHead"><div><h2>Transactional delivery</h2><div class="muted">Queued messages use bounded retry instead of being lost when the SMTP server is temporarily unavailable.</div></div><span class="muted">${recent.length} recent</span></div>${recent.length ? `<div class="tableWrap"><table class="dataTable emailLog"><thead><tr><th>Status</th><th>Type</th><th>Recipient</th><th>Attempts</th><th>Created</th><th>Last attempt</th><th>Error</th><th></th></tr></thead><tbody>${recent.map(row => `<tr><td>${deliveryPill(row.status)}</td><td>${esc(row.message_type)}</td><td>${esc(row.recipient_email)}</td><td>${Number(row.attempts || 0)}</td><td>${esc(date(row.created_at))}</td><td>${esc(date(row.last_attempt_at || row.sent_at))}</td><td>${row.last_error ? `<span class="errorText">${esc(row.last_error)}</span>` : '—'}</td><td>${row.status === 'failed' ? `<form method="post" action="/admin/notifications/email/${esc(row.id)}/retry">${csrfInput(req)}<button class="button secondary btn-sm">Retry</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No transactional emails have been queued yet.</div>'}</section>
        <style>.emailSettings{display:grid;grid-template-columns:2fr .7fr 1.3fr;gap:12px}.emailSettings label{display:grid;gap:5px}.emailSettings label>span{font-size:11px;font-weight:700;color:#9aa6b5}.emailSettings small{color:#748294;font-size:10px}.emailSettings .full{grid-column:1/-1}.gatewayActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.gatewayActions form{margin:0}.testMail{display:flex;gap:7px;min-width:min(520px,100%)}.emailLog{min-width:1100px}.errorText{color:#ef9298;max-width:320px;display:inline-block}.metricValue.smallish{font-size:22px}@media(max-width:850px){.emailSettings{grid-template-columns:1fr}.emailSettings .full{grid-column:auto}.testMail{min-width:100%}}</style>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'notifications', title: 'Notifications', subtitle: 'Transactional email gateway, delivery queue and retry health', body });
}

function cleanUsernameInput(value, settings) {
    const input = String(value || '').trim();
    if (input === '••••••••' && settings.source === 'browser' && settings.usernameConfigured) return null;
    return input;
}

function createAdminEmailRouter() {
    const router = express.Router();
    router.use('/admin/notifications', gate, noStore);
    router.get('/admin/notifications', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/notifications/email/settings', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (req.body.useEnvironment === '1') {
                await emailSettings.useEnvironment(req.session.authUserId);
                return res.redirect('/admin/notifications?message=' + encodeURIComponent('Email gateway returned to environment fallback.'));
            }
            const current = await emailSettings.status();
            const usernameInput = cleanUsernameInput(req.body.username, current);
            const cfg = await emailSettings.get();
            await emailSettings.save({
                ...req.body,
                username: usernameInput == null ? cfg.username : usernameInput
            }, req.session.authUserId);
            return res.redirect('/admin/notifications?message=' + encodeURIComponent('Email gateway saved. Test the connection before relying on delivery.'));
        } catch (error) {
            return res.redirect('/admin/notifications?error=' + encodeURIComponent(error.message || 'Email settings could not be saved.'));
        }
    });
    router.post('/admin/notifications/email/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await emailSettings.testConnection();
            return res.redirect('/admin/notifications?message=' + encodeURIComponent(`SMTP authenticated successfully in ${result.latencyMs} ms.`));
        } catch (error) {
            return res.redirect('/admin/notifications?error=' + encodeURIComponent(`SMTP test failed: ${error.message}`));
        }
    });
    router.post('/admin/notifications/email/send-test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const site = runtimeSettings.siteName();
            await emailSettings.send({ to: req.body.to, subject: `${site} email test`, text: `This is a test email from ${site}. Your SMTP gateway is working.`, html: `<p>This is a test email from <strong>${esc(site)}</strong>.</p><p>Your SMTP gateway is working.</p>` });
            return res.redirect('/admin/notifications?message=' + encodeURIComponent('Test email sent successfully.'));
        } catch (error) {
            return res.redirect('/admin/notifications?error=' + encodeURIComponent(`Test email failed: ${error.message}`));
        }
    });
    router.post('/admin/notifications/email/deliver', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await outbox.deliverDue({ limit: 50 });
            return res.redirect('/admin/notifications?message=' + encodeURIComponent(`Delivery run: ${result.sent} sent, ${result.failed} failed.`));
        } catch (error) {
            return res.redirect('/admin/notifications?error=' + encodeURIComponent(error.message || 'Delivery run failed.'));
        }
    });
    router.post('/admin/notifications/email/:id/retry', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await outbox.retry(req.params.id);
            return res.redirect('/admin/notifications?message=' + encodeURIComponent('Email queued for retry.'));
        } catch (error) {
            return res.redirect('/admin/notifications?error=' + encodeURIComponent(error.message || 'Email could not be retried.'));
        }
    });
    return router;
}

module.exports = { createAdminEmailRouter, page, emailHealthCard };
