'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const providerSettings = require('../payments/provider-settings');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
const integrationCard=require('./admin-integration-card');
const ui=require('./admin-ui');
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
function pill(label, kind = '') { return `<span class="pill ${kind}">${esc(label)}</span>`; }
function date(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB');
}
function checked(v) { return v === 'on' || v === '1' || v === true; }
function providerLabel(provider){return({stripe:'Stripe',paypal:'PayPal',coingate:'CoinGate'})[provider]||String(provider||'Provider');}

async function webhookUrls(req){
    const [stripe,paypal,coingate]=await Promise.all([
        operations.absoluteUrl(req,'/webhooks/stripe',{requireCanonical:false}),
        operations.absoluteUrl(req,'/webhooks/paypal',{requireCanonical:false}),
        operations.absoluteUrl(req,'/webhooks/coingate',{requireCanonical:false})
    ]);
    return{stripe,paypal,coingate};
}

async function paymentsData(req) {
    const [events, subs, customers, stripeStatus, paypalStatus,coingateStatus,urls] = await Promise.all([
        query(`SELECT id,provider,event_type,processed_at,(processing_error IS NOT NULL) AS failed,created_at FROM payment_events ORDER BY created_at DESC LIMIT 100`),
        query(`SELECT source,status,COUNT(*)::int count FROM subscriptions GROUP BY source,status ORDER BY source,status`),
        query(`SELECT provider,COUNT(*)::int count FROM payment_customers GROUP BY provider ORDER BY provider`),
        providerSettings.status('stripe'),
        providerSettings.status('paypal'),
        providerSettings.status('coingate'),
        webhookUrls(req)
    ]);
    return { events: events.rows, subscriptions: subs.rows, paymentCustomers: customers.rows, stripeStatus, paypalStatus,coingateStatus, webhookUrls:urls };
}

function secretField(name, label, help, configured = false) {
    return `<div class="formGroup"><label>${esc(label)}</label><input class="input" type="password" name="${esc(name)}" autocomplete="new-password" placeholder="${configured ? 'Configured — leave blank to keep current value' : 'Enter value'}"><div class="inlineHelp">${esc(help)}</div><label class="toggleRow compact"><input type="checkbox" name="clear_${esc(name)}"><span>Clear saved value</span></label></div>`;
}

function testForm(req, provider, disabled = false) {
    return `<form method="post" action="/admin/payments/${esc(provider)}/test" class="inlineForm">${csrfInput(req)}<button class="button secondary" type="submit" ${disabled ? 'disabled' : ''}>Test connection</button></form>`;
}
function copyField(value,label,id){
    return `<div class="formGroup"><label for="${esc(id)}">${esc(label)}</label><div class="copyField"><input id="${esc(id)}" class="input" value="${esc(value)}" readonly><button class="button secondary btn-sm" type="button" data-copy-value="${esc(value)}">Copy</button></div></div>`;
}
function setupSteps(provider,url){
    if(provider==='stripe')return `<div class="operatorDisclosureBody"><ol class="setupSteps"><li>Open Stripe Dashboard → Developers → Webhooks.</li><li>Add an endpoint using this exact URL:${copyField(url,'Stripe webhook URL','stripe-webhook-url')}</li><li>Subscribe to checkout/session, invoice, customer subscription, refund and dispute events used by CAPTAiNFiN.</li><li>Copy the endpoint <strong>Signing secret</strong> (<code>whsec_…</code>) into “Webhook signing secret” below.</li><li>Save here, then use <strong>Test connection</strong>. Incoming events will appear in Recent provider events.</li></ol><div class="operatorCallout warn">Checkout credentials alone are not enough for recurring access. Without the webhook signing secret, renewals, cancellations and failed-payment state cannot be trusted.</div></div>`;
    if(provider==='paypal')return `<div class="operatorDisclosureBody"><ol class="setupSteps"><li>Open the PayPal Developer dashboard and select the REST app used for CAPTAiNFiN.</li><li>Add a webhook using this exact URL:${copyField(url,'PayPal webhook URL','paypal-webhook-url')}</li><li>Subscribe to billing-subscription, completed payment/sale, refund and dispute lifecycle events.</li><li>Save the webhook in PayPal, then copy its <strong>Webhook ID</strong> into the field below. This is the ID, not the webhook URL.</li><li>Keep Sandbox selected while testing; switch to Live only when using the production REST app.</li></ol><div class="operatorCallout warn">Recurring PayPal access depends on verified webhook delivery. A Client ID/secret can start checkout but cannot safely keep subscription state synchronised on its own.</div></div>`;
    return `<div class="operatorDisclosureBody"><ol class="setupSteps"><li>Create or open a CoinGate API App and copy its API token.</li><li>Use Sandbox while testing. CoinGate Sandbox and Live use separate API credentials.</li><li>CAPTAiNFiN supplies this callback URL on every CoinGate order:${copyField(url,'CoinGate callback URL','coingate-webhook-url')}</li><li>You do not need to create a separate static webhook or paste a webhook secret. Browser-managed setup generates a private callback verifier automatically.</li><li>Save the API token here, use <strong>Test connection</strong>, then run a small Sandbox checkout.</li></ol><div class="operatorCallout warn">CoinGate is intentionally one-time crypto checkout in CAPTAiNFiN. A monthly or yearly plan receives its normal plan duration, but it does not auto-renew; the customer pays again for the next period.</div></div>`;
}

function providerHealthCard(req, provider, status, events) {
    const label=providerLabel(provider);
    const providerEvents=(events||[]).filter(event=>event.provider===provider);
    const latest=providerEvents[0]||null;
    const latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)||null;
    let statusLabel='Disabled',statusKind='',workingLabel='Disabled',workingKind='',fixHint=`Enable ${label} and save valid credentials.`;
    if(status.enabled&&!status.credentialsConfigured){
        statusLabel='Not configured';statusKind='warn';workingLabel='Credentials missing';workingKind='warn';fixHint=`Add ${label} API credentials below, save them, then test the connection.`;
    }else if(status.configured&&!status.webhookConfigured){
        statusLabel='Checkout only';statusKind='warn';workingLabel='Callback not ready';workingKind='warn';fixHint=`Finish the ${label} callback/webhook setup below before accepting payments.`;
    }else if(status.configured&&status.webhookConfigured&&latest?.failed){
        statusLabel='Needs attention';statusKind='warn';workingLabel='Latest callback failed';workingKind='warn';fixHint='Review Recent provider events and Payment incidents, then test the saved API credential.';
    }else if(status.configured&&status.webhookConfigured&&latestSuccessful){
        statusLabel='Connected';statusKind='good';workingLabel='Callback delivery observed';workingKind='good';fixHint='If events stop arriving, test the API credential and confirm the provider still targets this portal.';
    }else if(status.configured&&status.webhookConfigured){
        statusLabel='Configured';statusKind='good';workingLabel='Waiting for first callback';workingKind='';fixHint='Use Test connection, then send a provider test or checkout event to verify public callback delivery.';
    }
    const manageTarget=`#${provider}-provider`;
    const actions=`${testForm(req,provider,!status.credentialsConfigured)}<a class="button secondary btn-sm" href="${manageTarget}">Manage</a>`;
    const summary=status.source==='database'?'Browser-managed credentials and verified event delivery.':'Environment credentials and verified event delivery.';
    return integrationCard.renderIntegrationCard({ name:label, statusLabel, statusKind, summary, enabled:status.enabled, configured:status.configured&&status.webhookConfigured, workingLabel, workingKind, lastVerifiedAt:latestSuccessful?.processed_at||latestSuccessful?.created_at||null, lastVerifiedLabel:'Last successful provider event', fixHint, actionsHtml:actions });
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

function coingateForm(req,status,url){
    const badge=!status.enabled?pill('Disabled','warn'):status.configured?pill(status.webhookConfigured?'Ready':'Callback verifier missing',status.webhookConfigured?'good':'warn'):pill('Not configured');
    return `<section class="section" id="coingate-provider"><div class="sectionHead"><div><h2>CoinGate</h2><div class="muted">Hosted one-time crypto checkout with verified order callbacks. No provider price mappings are required.</div></div>${badge}</div>
    <details class="operatorDisclosure" ${!status.webhookConfigured?'open':''}><summary>How does CoinGate callback setup work?</summary>${setupSteps('coingate',url)}</details>
    <form class="formPanel" method="post" action="/admin/payments/coingate">${csrfInput(req)}
      <label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled?'checked':''}><span><strong>Enable CoinGate crypto gateway</strong><small class="muted">Disabling CoinGate preserves the saved token but removes crypto checkout from customer plans.</small></span></label>
      <div class="formGrid" style="margin-top:14px">
        <div class="formGroup"><label>Environment</label><select class="input" name="environment"><option value="sandbox" ${status.environment!=='live'?'selected':''}>Sandbox</option><option value="live" ${status.environment==='live'?'selected':''}>Live</option></select><div class="inlineHelp">Sandbox and Live have separate CoinGate API tokens.</div></div>
        ${secretField('apiToken','API token','CoinGate API App token. This is a server-side secret.',status.credentialsConfigured)}
      </div>
      <div class="operatorCallout">CAPTAiNFiN generates and stores its callback verifier internally when these browser-managed settings are saved. It is never sent to the browser.</div>
      <div class="buttonRow"><button class="button">Save CoinGate settings</button>${status.source==='database'?`<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>`:''}</div>
    </form>
    <div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">Tests the saved CoinGate ${esc(status.environment||'sandbox')} API token. A real Sandbox checkout is still the final callback-delivery test.</div></div>${testForm(req,'coingate',!status.credentialsConfigured)}</div></div>
    </section>`;
}

function providerReadiness(status){return Boolean(status.enabled&&status.credentialsConfigured&&status.webhookConfigured)}
function paymentHero(d){
    const failedEvents=d.events.filter(event=>event.failed);
    const statuses=[d.stripeStatus,d.paypalStatus,d.coingateStatus];
    const readyProviders=statuses.filter(providerReadiness).length;
    const enabledProviders=statuses.filter(status=>status.enabled).length;
    const stored=d.paymentCustomers.reduce((n,row)=>n+Number(row.count||0),0);
    const tracked=d.subscriptions.reduce((n,row)=>n+Number(row.count||0),0);
    const incomplete=[['Stripe',d.stripeStatus],['PayPal',d.paypalStatus],['CoinGate',d.coingateStatus]].filter(([,status])=>status.enabled&&!providerReadiness(status));
    const tone=failedEvents.length?'bad':incomplete.length?'warn':readyProviders?'commerce':'warn';
    const title=failedEvents.length?`${failedEvents.length} recent provider ${failedEvents.length===1?'event failed':'events failed'}`:incomplete.length?`${incomplete.length} enabled payment ${incomplete.length===1?'provider needs':'providers need'} setup`:readyProviders?'Payment providers are ready':'No payment provider is fully ready';
    const next=failedEvents.length?'Open the failed provider events below, then resolve any customer-impacting incident in Commerce.':incomplete[0]?`Finish ${incomplete[0][0]} credentials/callback setup and test the connection.`:readyProviders?'No payment infrastructure action is required.':'Enable and configure Stripe, PayPal or CoinGate before accepting direct payments.';
    return ui.operatorHero({tone,eyebrow:'Payment control room',title,body:'Provider readiness and failed callback processing are shown before credentials and raw event history.',statusLabel:failedEvents.length?'Action required':incomplete.length?'Setup incomplete':readyProviders?'Money flow ready':'Setup required',next,facts:[
        {label:'Ready providers',value:`${readyProviders} / 3`,detail:`${enabledProviders} enabled`},
        {label:'Recent failures',value:String(failedEvents.length),detail:'latest 100 provider events'},
        {label:'Provider customers',value:String(stored),detail:'stored Stripe/PayPal customer links'},
        {label:'Subscription states',value:String(tracked),detail:'local tracked access records'}
    ],actionsHtml:failedEvents.length?'<a class="button" href="#provider-failures">Inspect failed events</a><a class="button secondary" href="/admin/commerce#payment-incidents">Resolve payment incidents</a>':'<a class="button secondary" href="#provider-setup">Provider health</a><a class="button secondary" href="/admin/commerce">Commerce overview</a>'});
}

function eventTable(d){
    return d.events.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Time</th><th>Provider</th><th>Event</th><th>Processed</th><th>Result</th></tr></thead><tbody>${d.events.map(x => `<tr><td>${esc(date(x.created_at))}</td><td>${esc(x.provider)}</td><td>${esc(x.event_type)}</td><td>${esc(date(x.processed_at))}</td><td>${pill(x.failed ? 'error' : 'ok', x.failed ? 'bad' : 'good')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="emptyAction"><div><strong>No provider events received yet.</strong><div>Finish provider setup and send a provider test/checkout event.</div></div></div>';
}

async function page(req) {
    await Promise.all([providerSettings.ensureLoaded(),runtimeSettings.ensureLoaded()]);
    const d = await paymentsData(req);
    const stored = d.paymentCustomers.reduce((n, row) => n + Number(row.count || 0), 0);
    const failed=d.events.filter(event=>event.failed);
    const providers = `<section class="section" id="provider-setup"><div class="sectionHead"><div><h2>Provider health</h2><div class="muted">Enabled, configured, observed working state and recovery actions use the same layout for every payment provider.</div></div><a class="button secondary btn-sm" href="/admin/provider-mappings">Provider mappings</a></div><div class="integrationCardGrid">${providerHealthCard(req,'stripe',d.stripeStatus,d.events)}${providerHealthCard(req,'paypal',d.paypalStatus,d.events)}${providerHealthCard(req,'coingate',d.coingateStatus,d.events)}</div><div class="metrics" style="margin-top:12px"><div class="metric"><div class="metricLabel">Stored provider customers</div><div class="metricValue">${stored}</div><div class="subText">CoinGate orders do not require a stored provider-customer identity.</div></div></div></section>`;
    const state = `<section class="section" id="payment-operations"><div class="sectionHead"><div><h2>Operational payment state</h2><div class="muted">Read-only access counts from local records. Customer-impacting exceptions are handled in Commerce incidents.</div></div><a class="button secondary btn-sm" href="/admin/commerce#payment-incidents">Open incidents</a></div>${d.subscriptions.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Source</th><th>Status</th><th>Count</th></tr></thead><tbody>${d.subscriptions.map(x => `<tr><td>${esc(x.source)}</td><td>${pill(x.status)}</td><td>${esc(x.count)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No subscriptions yet.</div>'}</section>`;
    const failures=failed.length?`<section class="section" id="provider-failures">${ui.sectionHeader({title:'Failed provider events',description:'These recent callbacks failed processing. Customer-impacting resolution remains in Commerce incidents.'})}<div class="tableWrap"><table class="dataTable"><thead><tr><th>Time</th><th>Provider</th><th>Event</th><th>Processed</th><th>Result</th></tr></thead><tbody>${failed.map(x=>`<tr><td>${esc(date(x.created_at))}</td><td>${esc(x.provider)}</td><td>${esc(x.event_type)}</td><td>${esc(date(x.processed_at))}</td><td>${pill('error','bad')}</td></tr>`).join('')}</tbody></table></div></section>`:'';
    const providerSetup=ui.detailDisclosure({title:'Stripe, PayPal & CoinGate credentials',summary:'Configuration · open to add/change credentials or callback details',bodyHtml:`${stripeForm(req,d.stripeStatus,d.webhookUrls.stripe)}${paypalForm(req,d.paypalStatus,d.webhookUrls.paypal)}${coingateForm(req,d.coingateStatus,d.webhookUrls.coingate)}`});
    const events=`<section class="section">${ui.sectionHeader({title:'Recent provider events',description:'The latest 12 are shown by default; expand only when investigating provider delivery.'})}${d.events.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Time</th><th>Provider</th><th>Event</th><th>Result</th></tr></thead><tbody>${d.events.slice(0,12).map(x=>`<tr><td>${esc(date(x.created_at))}</td><td>${esc(x.provider)}</td><td>${esc(x.event_type)}</td><td>${pill(x.failed?'error':'ok',x.failed?'bad':'good')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No provider events yet.</div>'}${d.events.length>12?ui.detailDisclosure({title:`Full provider event history (${d.events.length})`,summary:'Detailed callback history',bodyHtml:eventTable(d)}):''}</section>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'payments', title: 'Payments', subtitle: 'Provider safety first; credentials and detailed event history stay out of the way until needed', body: `${integrationCard.styles()}${ui.noticesFromRequest(req)}${paymentHero(d)}${failures}${providers}${providerSetup}${state}${events}` });
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
        if (!providerSettings.PROVIDERS.includes(provider)) return res.status(404).send('Unknown provider');
        try {
            const result = await providerSettings.testConnection(provider);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.test','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ ok: true, limited: Boolean(result.limited) })]);
            return res.redirect('/admin/payments?message=' + encodeURIComponent(result.message));
        } catch (error) {
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.test','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 300) })]).catch(() => {});
            return res.redirect('/admin/payments?error=' + encodeURIComponent(`${providerLabel(provider)} test failed: ${error.message || error}`));
        }
    });
    router.post('/admin/payments/:provider', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const provider = req.params.provider;
        if (!providerSettings.PROVIDERS.includes(provider)) return res.status(404).send('Unknown provider');
        try {
            if (req.body.useEnvironment === '1') {
                await providerSettings.remove(provider, req.session.authUserId);
                return res.redirect('/admin/payments?message=' + encodeURIComponent(`${providerLabel(provider)} now uses environment fallback settings.`));
            }
            const input = provider === 'stripe' ? {
                enabled: checked(req.body.enabled), restrictedKey: req.body.restrictedKey, apiKey: req.body.apiKey, webhookSecret: req.body.webhookSecret,
                clearRestrictedKey: checked(req.body.clear_restrictedKey), clearApiKey: checked(req.body.clear_apiKey), clearWebhookSecret: checked(req.body.clear_webhookSecret)
            } : provider === 'coingate' ? {
                enabled: checked(req.body.enabled), environment: req.body.environment, apiToken: req.body.apiToken,
                clearApiToken: checked(req.body.clear_apiToken)
            } : {
                enabled: checked(req.body.enabled), environment: req.body.environment, clientId: req.body.clientId, clientSecret: req.body.clientSecret, webhookId: req.body.webhookId,
                clearClientId: checked(req.body.clear_clientId), clearClientSecret: checked(req.body.clear_clientSecret), clearWebhookId: checked(req.body.clear_webhookId)
            };
            const status = await providerSettings.save(provider, input, req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.update','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ enabled: status.enabled, configured: status.configured, webhookConfigured: status.webhookConfigured, environment: status.environment })]);
            return res.redirect('/admin/payments?message=' + encodeURIComponent(`${providerLabel(provider)} settings saved securely.`));
        } catch (error) {
            console.error('Payment settings update failed:', error.message);
            return res.redirect('/admin/payments?error=' + encodeURIComponent(error.message || 'Payment settings could not be saved.'));
        }
    });
    return router;
}

module.exports = { createAdminPaymentSettingsRouter, paymentsData, webhookUrls, providerHealthCard, paymentHero, eventTable, providerLabel, coingateForm };