'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const providerSettings = require('../payments/provider-settings');
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
function pill(label, kind = '') { return `<span class="pill ${kind}">${esc(label)}</span>`; }
function date(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB');
}
function checked(v) { return v === 'on' || v === '1' || v === true; }

async function paymentsData() {
    const [events, subs, customers, stripeStatus, paypalStatus] = await Promise.all([
        query(`SELECT id,provider,event_type,processed_at,(processing_error IS NOT NULL) AS failed,created_at FROM payment_events ORDER BY created_at DESC LIMIT 100`),
        query(`SELECT source,status,COUNT(*)::int count FROM subscriptions GROUP BY source,status ORDER BY source,status`),
        query(`SELECT provider,COUNT(*)::int count FROM payment_customers GROUP BY provider ORDER BY provider`),
        providerSettings.status('stripe'),
        providerSettings.status('paypal')
    ]);
    return {
        events: events.rows,
        subscriptions: subs.rows,
        paymentCustomers: customers.rows,
        stripeStatus,
        paypalStatus
    };
}

function providerMetric(status, label) {
    const value = !status.enabled ? 'Disabled' : status.configured && status.webhookConfigured ? 'Ready' : status.configured ? 'Checkout only' : 'Not configured';
    const source = status.source === 'database' ? 'Browser-managed' : 'Environment fallback';
    return `<div class="metric"><div class="metricLabel">${esc(label)}</div><div class="metricValue small">${esc(value)}</div><div class="subText">${esc(source)}</div></div>`;
}

function secretField(name, label, help, configured = false) {
    return `<div class="formGroup"><label>${esc(label)}</label><input class="input" type="password" name="${esc(name)}" autocomplete="new-password" placeholder="${configured ? 'Configured — leave blank to keep current value' : 'Enter value'}"><div class="inlineHelp">${esc(help)}</div><label class="toggleRow compact"><input type="checkbox" name="clear_${esc(name)}"><span>Clear saved value</span></label></div>`;
}

function testForm(req, provider, disabled = false) {
    return `<form method="post" action="/admin/payments/${esc(provider)}/test" class="inlineForm">${csrfInput(req)}<button class="button secondary" type="submit" ${disabled ? 'disabled' : ''}>Test connection</button></form>`;
}

function stripeForm(req, status) {
    const badge = !status.enabled ? pill('Disabled', 'warn') : status.configured ? pill(status.webhookConfigured ? 'Ready' : 'Webhook missing', status.webhookConfigured ? 'good' : 'warn') : pill('Not configured');
    return `<section class="section"><div class="sectionHead"><div><h2>Stripe</h2><div class="muted">Configure checkout and webhook credentials in the browser. Secret values are encrypted at rest and never displayed again.</div></div>${badge}</div>
    <form class="formPanel" method="post" action="/admin/payments/stripe">${csrfInput(req)}
      <label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable Stripe gateway</strong><small class="muted">When disabled, Stripe checkout and webhook handling are unavailable while saved credentials are retained.</small></span></label>
      <div class="formGrid" style="margin-top:14px">
        ${secretField('restrictedKey','Restricted key','Preferred Stripe server credential.', status.credentialsConfigured)}
        ${secretField('apiKey','Secret API key fallback','Optional fallback if you are not using a restricted key.', status.credentialsConfigured)}
        ${secretField('webhookSecret','Webhook signing secret','Required to process Stripe subscription renewals, cancellations and failed payments.', status.webhookConfigured)}
      </div>
      <div class="buttonRow"><button class="button">Save Stripe settings</button>${status.source === 'database' ? `<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>` : ''}</div>
    </form>
    <div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">Tests the saved Stripe credential against the Stripe API. Save any changed fields first.</div></div>${testForm(req, 'stripe', !status.credentialsConfigured)}</div></div>
    </section>`;
}

function paypalForm(req, status) {
    const badge = !status.enabled ? pill('Disabled', 'warn') : status.configured ? pill(status.webhookConfigured ? 'Ready' : 'Webhook missing', status.webhookConfigured ? 'good' : 'warn') : pill('Not configured');
    return `<section class="section"><div class="sectionHead"><div><h2>PayPal</h2><div class="muted">Client credentials and webhook ID are encrypted at rest. Choose sandbox while testing and live for production.</div></div>${badge}</div>
    <form class="formPanel" method="post" action="/admin/payments/paypal">${csrfInput(req)}
      <label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable PayPal gateway</strong><small class="muted">Disabling PayPal preserves the saved credentials but removes it from checkout.</small></span></label>
      <div class="formGrid" style="margin-top:14px">
        <div class="formGroup"><label>Environment</label><select class="input" name="environment"><option value="sandbox" ${status.environment !== 'live' ? 'selected' : ''}>Sandbox</option><option value="live" ${status.environment === 'live' ? 'selected' : ''}>Live</option></select></div>
        ${secretField('clientId','Client ID','PayPal REST app client ID.', status.credentialsConfigured)}
        ${secretField('clientSecret','Client secret','PayPal REST app secret.', status.credentialsConfigured)}
        ${secretField('webhookId','Webhook ID','Required to verify PayPal subscription lifecycle events.', status.webhookConfigured)}
      </div>
      <div class="buttonRow"><button class="button">Save PayPal settings</button>${status.source === 'database' ? `<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>` : ''}</div>
    </form>
    <div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">Requests a PayPal OAuth access token using the saved ${esc(status.environment || 'sandbox')} credentials. Save changed fields first.</div></div>${testForm(req, 'paypal', !status.credentialsConfigured)}</div></div>
    </section>`;
}

async function page(req) {
    await providerSettings.ensureLoaded();
    const d = await paymentsData();
    const stored = d.paymentCustomers.reduce((n, row) => n + Number(row.count || 0), 0);
    const metrics = `<div class="metrics">${providerMetric(d.stripeStatus, 'Stripe')}${providerMetric(d.paypalStatus, 'PayPal')}<div class="metric"><div class="metricLabel">Stored provider customers</div><div class="metricValue">${stored}</div></div></div>`;
    const state = `<section class="section"><div class="sectionHead"><h2>Subscription state</h2></div>${d.subscriptions.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Source</th><th>Status</th><th>Count</th></tr></thead><tbody>${d.subscriptions.map(x => `<tr><td>${esc(x.source)}</td><td>${pill(x.status)}</td><td>${esc(x.count)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No subscriptions yet.</div>'}</section>`;
    const events = `<section class="section"><div class="sectionHead"><h2>Recent provider events</h2></div>${d.events.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Time</th><th>Provider</th><th>Event</th><th>Processed</th><th>Result</th></tr></thead><tbody>${d.events.map(x => `<tr><td>${esc(date(x.created_at))}</td><td>${esc(x.provider)}</td><td>${esc(x.event_type)}</td><td>${esc(date(x.processed_at))}</td><td>${pill(x.failed ? 'error' : 'ok', x.failed ? 'bad' : 'good')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No provider events yet.</div>'}</section>`;
    return layout({ siteName: process.env.SITE_NAME || 'CAPTaINFiN', active: 'payments', title: 'Payments', subtitle: 'Payment gateways, checkout modes, subscriptions and webhook processing', body: `${notice(req)}${metrics}${stripeForm(req, d.stripeStatus)}${paypalForm(req, d.paypalStatus)}${state}${events}` });
}

function createAdminPaymentSettingsRouter() {
    const router = express.Router();
    router.use('/admin/payments', gate, noStore);
    router.get('/admin/payments', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/payments/:provider/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const provider = req.params.provider;
        if (!['stripe','paypal'].includes(provider)) return res.status(404).send('Unknown provider');
        try {
            const result = await providerSettings.testConnection(provider);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.test','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ ok: true, limited: Boolean(result.limited) })]);
            return res.redirect('/admin/payments?message=' + encodeURIComponent(result.message));
        } catch (error) {
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.test','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 300) })]).catch(() => {});
            return res.redirect('/admin/payments?error=' + encodeURIComponent(`${provider === 'stripe' ? 'Stripe' : 'PayPal'} test failed: ${error.message || error}`));
        }
    });
    router.post('/admin/payments/:provider', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const provider = req.params.provider;
        if (!['stripe','paypal'].includes(provider)) return res.status(404).send('Unknown provider');
        try {
            if (req.body.useEnvironment === '1') {
                await providerSettings.remove(provider, req.session.authUserId);
                return res.redirect('/admin/payments?message=' + encodeURIComponent(`${provider === 'stripe' ? 'Stripe' : 'PayPal'} now uses environment fallback settings.`));
            }
            const input = provider === 'stripe' ? {
                enabled: checked(req.body.enabled),
                restrictedKey: req.body.restrictedKey,
                apiKey: req.body.apiKey,
                webhookSecret: req.body.webhookSecret,
                clearRestrictedKey: checked(req.body.clear_restrictedKey),
                clearApiKey: checked(req.body.clear_apiKey),
                clearWebhookSecret: checked(req.body.clear_webhookSecret)
            } : {
                enabled: checked(req.body.enabled),
                environment: req.body.environment,
                clientId: req.body.clientId,
                clientSecret: req.body.clientSecret,
                webhookId: req.body.webhookId,
                clearClientId: checked(req.body.clear_clientId),
                clearClientSecret: checked(req.body.clear_clientSecret),
                clearWebhookId: checked(req.body.clear_webhookId)
            };
            const status = await providerSettings.save(provider, input, req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.update','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ enabled: status.enabled, configured: status.configured, webhookConfigured: status.webhookConfigured, environment: status.environment })]);
            return res.redirect('/admin/payments?message=' + encodeURIComponent(`${provider === 'stripe' ? 'Stripe' : 'PayPal'} settings saved securely.`));
        } catch (error) {
            console.error('Payment settings update failed:', error.message);
            return res.redirect('/admin/payments?error=' + encodeURIComponent(error.message || 'Payment settings could not be saved.'));
        }
    });
    return router;
}

module.exports = { createAdminPaymentSettingsRouter, paymentsData };
