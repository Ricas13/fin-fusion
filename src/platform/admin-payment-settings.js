'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const providerSettings = require('../payments/provider-settings');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
const integrationCard=require('./admin-integration-card');
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

async function webhookUrls(req){
    const [stripe,paypal]=await Promise.all([
        operations.absoluteUrl(req,'/webhooks/stripe',{requireCanonical:false}),
        operations.absoluteUrl(req,'/webhooks/paypal',{requireCanonical:false})
    ]);
    return{stripe,paypal};
}

async function paymentsData(req) {
    const [events, subs, customers, stripeStatus, paypalStatus,urls] = await Promise.all([
        query(`SELECT id,provider,event_type,processed_at,(processing_error IS NOT NULL) AS failed,created_at FROM payment_events ORDER BY created_at DESC LIMIT 100`),
        query(`SELECT source,status,COUNT(*)::int count FROM subscriptions GROUP BY source,status ORDER BY source,status`),
        query(`SELECT provider,COUNT(*)::int count FROM payment_customers GROUP BY provider ORDER BY provider`),
        providerSettings.status('stripe'),
        providerSettings.status('paypal'),
        webhookUrls(req)
    ]);
    return {
        events: events.rows,
        subscriptions: subs.rows,
        paymentCustomers: customers.rows,
        stripeStatus,
        paypalStatus,
        webhookUrls:urls
    };
}

function workflowIntro(d) {
    const failedEvents = d.events.filter(event => event.failed).length;
    const subscriptionStates = d.subscriptions.reduce((sum, row) => sum + Number(row.count || 0), 0);
    return `<section class="section paymentWorkflowIntro"><div class="sectionHead"><div><h2>Payment workflow</h2><div class="muted">Setup controls and live payment problems are separated so daily operations do not feel like provider configuration.</div></div></div><div class="quick-actions"><a class="quick-action" href="#provider-setup"><strong>Provider setup</strong><span>Configure Stripe, PayPal, credentials, webhooks and connection tests.</span></a><a class="quick-action" href="#payment-operations"><strong>Operational monitoring</strong><span>${esc(subscriptionStates)} tracked subscription state${subscriptionStates === 1 ? '' : 's'} and ${esc(failedEvents)} failed recent provider event${failedEvents === 1 ? '' : 's'}.</span></a><a class="quick-action" href="/admin/commerce#payment-incidents"><strong>Payment incidents</strong><span>Customer-impacting failures, assignment, acknowledgement and resolution live in Commerce.</span></a></div></section>`;
}

function secretField(name, label, help, configured = false) {
    return `<div class="formGroup"><label>${esc(label)}</label><input class="input" type="password" name="${esc(name)}" autocomplete="new-password" placeholder="${configured ? 'Configured — leave blank to keep current value' : 'Enter value'}"><div class="inlineHelp">${esc(help)}</div><label class="toggleRow compact"><input type="checkbox" name="clear_${esc(name)}"><span>Clear saved value</span></label></div>`;
}

function testForm(req, provider, disabled = false) {
    return `<form method="post" action="/admin/payments/${esc(provider)}/test" class="inlineForm">${csrfInput(req)}<button class="button secondary" type="submit" ${disabled ? 'disabled' : ''}>Test connection</button></form>`;
}
function copyField(value){return `<div class="copyField"><input class="input" value="${esc(value)}" readonly><button class="button secondary btn-sm" type="button" data-copy-value="${esc(value)}">Copy</button></div>`}
function setupSteps(provider,url){
    if(provider==='stripe')return `<div class="operatorDisclosureBody"><ol class="setupSteps"><li>Open Stripe Dashboard → Developers → Webhooks.</li><li>Add an endpoint using this exact URL:${copyField(url)}</li><li>Subscribe to checkout/session, invoice, customer subscription, refund and dispute events used by CAPTAiNFiN.</li><li>Copy the endpoint <strong>Signing secret</strong> (<code>whsec_…</code>) into “Webhook signing secret” below.</li><li>Save here, then use <strong>Test connection</strong>. Incoming events will appear in Recent provider events.</li></ol><div class="operatorCallout warn">Checkout credentials alone are not enough for recurring access. Without the webhook signing secret, renewals, cancellations and failed-payment state cannot be trusted.</div></div>`;
    return `<div class="operatorDisclosureBody"><ol class="setupSteps"><li>Open the PayPal Developer dashboard and select the REST app used for CAPTAiNFiN.</li><li>Add a webhook using this exact URL:${copyField(url)}</li><li>Subscribe to billing-subscription, completed payment/sale, refund and dispute lifecycle events.</li><li>Save the webhook in PayPal, then copy its <strong>Webhook ID</strong> into the field below. This is the ID, not the webhook URL.</li><li>Keep Sandbox selected while testing; switch to Live only when using the production REST app.</li></ol><div class="operatorCallout warn">Recurring PayPal access depends on verified webhook delivery. A Client ID/secret can start checkout but cannot safely keep subscription state synchronised on its own.</div></div>`;
}

function providerHealthCard(req, provider, status, events) {
    const label=provider==='stripe'?'Stripe':'PayPal';
    const providerEvents=(events||[]).filter(event=>event.provider===provider);
    const latest=providerEvents[0]||null;
    const latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)||null;
    let statusLabel='Disabled',statusKind='',workingLabel='Disabled',workingKind='',fixHint=`Enable ${label} and save valid credentials.`;
    if(status.enabled&&!status.credentialsConfigured){
        statusLabel='Not configured';statusKind='warn';workingLabel='Credentials missing';workingKind='warn';fixHint=`Add ${label} API credentials below, save them, then test the connection.`;
    }else if(status.configured&&!status.webhookConfigured){
        statusLabel='Checkout only';statusKind='warn';workingLabel='Webhook not configured';workingKind='warn';fixHint=`Configure the ${label} webhook below so renewals, cancellations and failures can be trusted.`;
    }else if(status.configured&&status.webhookConfigured&&latest?.failed){
        statusLabel='Needs attention';statusKind='warn';workingLabel='Latest webhook failed';workingKind='warn';fixHint='Review Recent provider events and Payment incidents, then test the saved API credential.';
    }else if(status.configured&&status.webhookConfigured&&latestSuccessful){
        statusLabel='Connected';statusKind='good';workingLabel='Webhook delivery observed';workingKind='good';fixHint='If events stop arriving, test the API credential and confirm the provider webhook still targets this portal.';
    }else if(status.configured&&status.webhookConfigured){
        statusLabel='Configured';statusKind='good';workingLabel='Waiting for first webhook event';workingKind='';fixHint='Use Test connection, then send a provider test or checkout event to verify public webhook delivery.';
    }
    const manageTarget=provider==='stripe'?'#stripe-provider':'#paypal-provider';
    const actions=`${testForm(req,provider,!status.credentialsConfigured)}<a class="button secondary btn-sm" href="${manageTarget}">Manage</a>`;
    const summary=status.source==='database'?'Browser-managed credentials and verified event delivery.':'Environment credentials and verified event delivery.';
    return integrationCard.renderIntegrationCard({
        name:label,
        statusLabel,
        statusKind,
        summary,
        enabled:status.enabled,
        configured:status.configured&&status.webhookConfigured,
        workingLabel,
        workingKind,
        lastVerifiedAt:latestSuccessful?.processed_at||latestSuccessful?.created_at||null,
        lastVerifiedLabel:'Last successful provider event',
        fixHint,
        actionsHtml:actions
    });
}

function stripeForm(req, status,url) {
    const badge = !status.enabled ? pill('Disabled', 'warn') : status.configured ? pill(status.webhookConfigured ? 'Ready' : 'Webhook missing', status.webhookConfigured ? 'good' : 'warn') : pill('Not configured');
    return `<section class="section" id="stripe-provider"><div class="sectionHead"><div><h2>Stripe</h2><div class="muted">Checkout, recurring billing and verified event delivery in one setup flow.</div></div>${badge}</div>
    <details class="operatorDisclosure" ${!status.webhookConfigured?'open':''}><summary>Where do I get the Stripe webhook?</summary>${setupSteps('stripe',url)}</details>
    <form class="formPanel" method="post" action="/admin/payments/stripe">${csrfInput(req)}
      <label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable Stripe gateway</strong><small class="muted">When disabled, Stripe checkout and webhook handling are unavailable while saved credentials are retained.</small></span></label>
      <div class="formGrid" style="margin-top:14px">
        ${secretField('restrictedKey','Restricted key','Preferred Stripe server credential.', status.credentialsConfigured)}
        ${secretField('apiKey','Secret API key fallback','Optional fallback if you are not using a restricted key.', status.credentialsConfigured)}
        ${secretField('webhookSecret','Webhook signing secret (whsec_…)','From the Stripe webhook endpoint created with the URL shown above.', status.webhookConfigured)}
      </div>
      <div class="buttonRow"><button class="button">Save Stripe settings</button>${status.source === 'database' ? `<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>` : ''}</div>
    </form>
    <div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">Tests the saved Stripe credential against the Stripe API. Webhook readiness is shown separately because Stripe must call your public endpoint.</div></div>${testForm(req, 'stripe', !status.credentialsConfigured)}</div></div>
    </section>`;
}

function paypalForm(req, status,url) {
    const badge = !status.enabled ? pill('Disabled', 'warn') : status.configured ? pill(status.webhookConfigured ? 'Ready' : 'Webhook missing', status.webhookConfigured ? 'good' : 'warn') : pill('Not configured');
    return `<section class="section" id="paypal-provider"><div class="sectionHead"><div><h2>PayPal</h2><div class="muted">REST credentials, environment and verified recurring-event delivery.</div></div>${badge}</div>
    <details class="operatorDisclosure" ${!status.webhookConfigured?'open':''}><summary>Where do I get the PayPal webhook ID?</summary>${setupSteps('paypal',url)}</details>
    <form class="formPanel" method="post" action="/admin/payments/paypal">${csrfInput(req)}
      <label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable PayPal gateway</strong><small class="muted">Disabling PayPal preserves the saved credentials but removes it from checkout.</small></span></label>
      <div class="formGrid" style="margin-top:14px">
        <div class="formGroup"><label>Environment</label><select class="input" name="environment"><option value="sandbox" ${status.environment !== 'live' ? 'selected' : ''}>Sandbox</option><option value="live" ${status.environment === 'live' ? 'selected' : ''}>Live</option></select></div>
        ${secretField('clientId','Client ID','PayPal REST app client ID.', status.credentialsConfigured)}
        ${secretField('clientSecret','Client secret','PayPal REST app secret.', status.credentialsConfigured)}
        ${secretField('webhookId','Webhook ID','The ID PayPal creates for the webhook endpoint shown above.', status.webhookConfigured)}
      </div>
      <div class="buttonRow"><button class="button">Save PayPal settings</button>${status.source === 'database' ? `<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>` : ''}</div>
    </form>
    <div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">Requests a PayPal OAuth access token using the saved ${esc(status.environment || 'sandbox')} credentials.</div></div>${testForm(req, 'paypal', !status.credentialsConfigured)}</div></div>
    </section>`;
}

async function page(req) {
    await Promise.all([providerSettings.ensureLoaded(),runtimeSettings.ensureLoaded()]);
    const d = await paymentsData(req);
    const stored = d.paymentCustomers.reduce((n, row) => n + Number(row.count || 0), 0);
    const providers = `<section class="section" id="provider-setup"><div class="sectionHead"><div><h2>Provider setup</h2><div class="muted">Enabled, configured, observed working state and recovery actions use the same layout for every payment provider.</div></div><a class="button secondary btn-sm" href="/admin/provider-mappings">Provider mappings</a></div><div class="integrationCardGrid">${providerHealthCard(req,'stripe',d.stripeStatus,d.events)}${providerHealthCard(req,'paypal',d.paypalStatus,d.events)}</div><div class="metrics" style="margin-top:12px"><div class="metric"><div class="metricLabel">Stored provider customers</div><div class="metricValue">${stored}</div></div></div></section>`;
    const state = `<section class="section" id="payment-operations"><div class="sectionHead"><div><h2>Operational payment state</h2><div class="muted">Read-only subscription counts from local records. Customer-impacting exceptions are handled in Commerce incidents.</div></div><a class="button secondary btn-sm" href="/admin/commerce#payment-incidents">Open incidents</a></div>${d.subscriptions.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Source</th><th>Status</th><th>Count</th></tr></thead><tbody>${d.subscriptions.map(x => `<tr><td>${esc(x.source)}</td><td>${pill(x.status)}</td><td>${esc(x.count)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No subscriptions yet.</div>'}</section>`;
    const events = `<section class="section"><div class="sectionHead"><h2>Recent provider events</h2><span class="muted">Use this to confirm your public webhook is actually receiving and processing events.</span></div>${d.events.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Time</th><th>Provider</th><th>Event</th><th>Processed</th><th>Result</th></tr></thead><tbody>${d.events.map(x => `<tr><td>${esc(date(x.created_at))}</td><td>${esc(x.provider)}</td><td>${esc(x.event_type)}</td><td>${esc(date(x.processed_at))}</td><td>${pill(x.failed ? 'error' : 'ok', x.failed ? 'bad' : 'good')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="emptyAction"><div><strong>No webhook events received yet.</strong><div>Finish one of the setup guides above and send a provider test/checkout event.</div></div></div>'}</section>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'payments', title: 'Payments', subtitle: 'Provider setup is separated from operational payment monitoring and customer incidents', body: `${integrationCard.styles()}${notice(req)}${workflowIntro(d)}${providers}${stripeForm(req, d.stripeStatus,d.webhookUrls.stripe)}${paypalForm(req, d.paypalStatus,d.webhookUrls.paypal)}${state}${events}` });
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

module.exports = { createAdminPaymentSettingsRouter, paymentsData, webhookUrls, providerHealthCard };
