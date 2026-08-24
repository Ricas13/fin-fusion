'use strict';

const { query } = require('../db');
const csrf = require('../auth/csrf');
const providerSettings = require('../payments/provider-settings');
const emailSettings = require('../integrations/email-settings');
const operations = require('./operations-settings');
const runtimeSettings = require('./runtime-settings');
const { esc } = require('./admin-html');

const PAYMENT_PROVIDERS = Object.freeze(['stripe', 'paypal', 'plisio']);

function csrfInput(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}
function checked(value) {
    return value === 'on' || value === '1' || value === true;
}
function providerLabel(provider) {
    return ({ stripe: 'Stripe', paypal: 'PayPal', plisio: 'Plisio' })[provider] || 'Payment provider';
}
function returnUrl(message = '', error = '', anchor = '') {
    const params = new URLSearchParams();
    if (message) params.set('message', message);
    if (error) params.set('error', error);
    return `/admin/settings/integrations${params.size ? `?${params.toString()}` : ''}${anchor ? `#${anchor}` : ''}`;
}
function secretField(name, label, configured, help = '') {
    return `<div class="integrationInlineField"><span>${esc(label)}</span><input class="input" type="password" name="${esc(name)}" autocomplete="new-password" placeholder="${configured ? 'Configured — leave blank to keep' : 'Enter value'}">${help ? `<small>${esc(help)}</small>` : ''}<label class="toggleRow compact integrationInlineClear"><input type="checkbox" name="clear_${esc(name)}"><span>Clear saved value</span></label></div>`;
}
function copyField(value, label, id) {
    return `<label class="integrationInlineField"><span>${esc(label)}</span><div class="copyField"><input id="${esc(id)}" class="input" value="${esc(value)}" readonly><button class="button secondary btn-sm" type="button" data-copy-value="${esc(value)}">Copy</button></div></label>`;
}
async function webhookUrls(req) {
    const [stripe, paypal, plisio] = await Promise.all([
        operations.absoluteUrl(req, '/webhooks/stripe', { requireCanonical: false }),
        operations.absoluteUrl(req, '/webhooks/paypal', { requireCanonical: false }),
        operations.absoluteUrl(req, '/webhooks/plisio?json=true', { requireCanonical: false })
    ]);
    return { stripe, paypal, plisio };
}
function providerForm(req, provider, status, callbackUrl) {
    const label = providerLabel(provider);
    const callbackLabel = provider === 'plisio' ? 'Callback URL' : 'Webhook URL';
    let fields = '';
    if (provider === 'stripe') {
        fields = `${secretField('restrictedKey', 'Restricted key', status.credentialsConfigured, 'Preferred server credential.')}${secretField('apiKey', 'Secret API key fallback', status.credentialsConfigured, 'Optional fallback credential.')}${secretField('webhookSecret', 'Webhook signing secret', status.webhookConfigured, 'Stripe whsec_… signing secret.')}`;
    } else if (provider === 'paypal') {
        fields = `<label class="integrationInlineField"><span>Environment</span><select class="input" name="environment"><option value="sandbox" ${status.environment !== 'live' ? 'selected' : ''}>Sandbox</option><option value="live" ${status.environment === 'live' ? 'selected' : ''}>Live</option></select></label>${secretField('clientId', 'Client ID', status.credentialsConfigured)}${secretField('clientSecret', 'Client secret', status.credentialsConfigured)}${secretField('webhookId', 'Webhook ID', status.webhookConfigured)}`;
    } else {
        fields = secretField('secretKey', 'Merchant SECRET_KEY', status.credentialsConfigured, 'Used for Plisio API calls and signed callback verification.');
    }
    const callbackHelp = provider === 'plisio'
        ? 'CAPTAiNFiN verifies the signed callback and then fetches the transaction independently before granting access.'
        : 'The public provider callback must remain configured for verified payment lifecycle events.';
    return `<div class="integrationInlinePanel">
        <div class="integrationInlinePanelHead"><div><strong>${esc(label)} settings</strong><span>Credentials and ${provider === 'plisio' ? 'signed callback' : 'webhook'} stay inside this Connections card.</span></div><form method="post" action="/admin/settings/integrations/payments/${esc(provider)}/test" data-native-submit="true">${csrfInput(req)}<button class="button secondary btn-sm" type="submit" ${status.credentialsConfigured ? '' : 'disabled'}>Test connection</button></form></div>
        ${copyField(callbackUrl, `${label} ${callbackLabel}`, `connections-${provider}-callback`)}
        <div class="integrationInlineHelp">${esc(callbackHelp)}</div>
        <form class="integrationInlineForm" method="post" action="/admin/settings/integrations/payments/${esc(provider)}" data-native-submit="true">
            ${csrfInput(req)}
            <label class="toggleRow integrationInlineEnable"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable ${esc(label)}</strong><small>Saved credentials remain available when the provider is disabled.</small></span></label>
            <div class="integrationInlineFields">${fields}</div>
            <div class="buttonRow integrationInlineButtons"><button class="button" type="submit">Save ${esc(label)}</button>${status.source === 'database' ? '<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback</button>' : ''}<a class="button secondary" href="/admin/payments">Advanced provider health</a></div>
        </form>
    </div>`;
}
function emailForm(req, status) {
    const defaultPort = status.port || (status.secureMode === 'tls' ? 465 : 587);
    const username = status.source === 'browser' && status.usernameConfigured ? '••••••••' : '';
    return `<div class="integrationInlinePanel">
        <div class="integrationInlinePanelHead"><div><strong>Transactional email settings</strong><span>SMTP configuration and tests stay inside this Connections card.</span></div><form method="post" action="/admin/settings/integrations/email/test" data-native-submit="true">${csrfInput(req)}<button class="button secondary btn-sm" type="submit" ${status.configured ? '' : 'disabled'}>Test connection</button></form></div>
        <form class="integrationInlineForm" method="post" action="/admin/settings/integrations/email/settings" data-native-submit="true">
            ${csrfInput(req)}
            <label class="toggleRow integrationInlineEnable"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable transactional email</strong><small>Activation, password reset and support messages can be delivered.</small></span></label>
            <div class="integrationInlineFields integrationInlineEmailFields">
                <label class="integrationInlineField"><span>SMTP host</span><input class="input" name="host" maxlength="255" required value="${esc(status.host || '')}" placeholder="smtp.example.com"></label>
                <label class="integrationInlineField"><span>Port</span><input class="input" type="number" min="1" max="65535" name="port" required value="${esc(defaultPort)}"></label>
                <label class="integrationInlineField"><span>Security</span><select class="input" name="secureMode"><option value="starttls" ${status.secureMode === 'starttls' ? 'selected' : ''}>STARTTLS</option><option value="tls" ${status.secureMode === 'tls' ? 'selected' : ''}>TLS from connect</option><option value="plain" ${status.secureMode === 'plain' ? 'selected' : ''}>Plain SMTP</option></select></label>
                <label class="integrationInlineField"><span>Username</span><input class="input" name="username" maxlength="300" autocomplete="off" value="${esc(username)}" placeholder="SMTP username"><small>Leave the masked value unchanged to keep the saved username.</small></label>
                <label class="integrationInlineField"><span>Password</span><input class="input" type="password" name="password" maxlength="500" autocomplete="new-password" placeholder="${status.passwordConfigured ? 'Saved — leave blank to keep' : 'SMTP password'}"><small>${status.passwordConfigured ? 'A password is stored encrypted.' : 'No browser password is stored.'}</small></label>
                <label class="integrationInlineField"><span>From name</span><input class="input" name="fromName" maxlength="120" value="${esc(status.fromName || runtimeSettings.siteName())}"></label>
                <label class="integrationInlineField"><span>From email</span><input class="input" type="email" name="fromEmail" maxlength="254" required value="${esc(status.fromEmail || '')}" placeholder="support@example.com"></label>
                <label class="integrationInlineField"><span>Reply-to</span><input class="input" type="email" name="replyTo" maxlength="254" value="${esc(status.replyTo || '')}" placeholder="Optional"></label>
            </div>
            <label class="toggleRow compact integrationInlinePasswordClear"><input type="checkbox" name="clearPassword"><span>Clear saved password</span></label>
            <div class="buttonRow integrationInlineButtons"><button class="button" type="submit">Save email gateway</button>${status.source === 'browser' ? '<button class="button secondary" name="useEnvironment" value="1" type="submit">Use environment fallback</button>' : ''}<a class="button secondary" href="/admin/notifications">Delivery history</a></div>
        </form>
        <form class="integrationInlineTestMail" method="post" action="/admin/settings/integrations/email/send-test" data-native-submit="true">${csrfInput(req)}<input class="input" type="email" name="to" required placeholder="Send test email to…"><button class="button secondary" ${status.configured ? '' : 'disabled'}>Send test email</button></form>
    </div>`;
}
function manager(req, row, state, urls) {
    const inner = row.key === 'email'
        ? emailForm(req, state.email || {})
        : providerForm(req, row.key, state[row.key] || {}, urls[row.key] || '');
    return `<details class="integrationOverviewManage" name="core-integration-manage" id="integration-${esc(row.key)}"${row.issue ? ' open' : ''}><summary><span>${row.issue ? 'Fix setup' : 'Manage'}</span><span aria-hidden="true">⌄</span></summary>${inner}</details>`;
}
function paymentProviderSummary(rows) {
    const paymentRows = rows.filter(row => PAYMENT_PROVIDERS.includes(row.key));
    const ready = paymentRows.filter(row => row.enabled && row.configured);
    if (!ready.length) return 'No checkout provider is ready yet.';
    if (ready.length === 1) return `${ready[0].name} is the only ready checkout provider.`;
    return `${ready.map(row => row.name).join(', ')} are ready. There is no hidden global default; each plan’s provider mappings decide which checkout options are offered.`;
}
async function auditPaymentTest(actorUserId, provider, result, error = null) {
    const metadata = error
        ? { ok: false, error: String(error.message || error).slice(0, 300) }
        : { ok: true, limited: Boolean(result?.limited) };
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.test','payment_provider',$2,$3::jsonb)`, [actorUserId, provider, JSON.stringify(metadata)]).catch(() => {});
}
function registerRoutes(router) {
    router.post('/admin/settings/integrations/payments/:provider/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const provider = req.params.provider;
        if (!PAYMENT_PROVIDERS.includes(provider)) return res.status(404).send('Unknown provider');
        try {
            const result = await providerSettings.testConnection(provider);
            await auditPaymentTest(req.session.authUserId, provider, result);
            return res.redirect(returnUrl(result.message, '', `integration-${provider}`));
        } catch (error) {
            await auditPaymentTest(req.session.authUserId, provider, null, error);
            return res.redirect(returnUrl('', `${providerLabel(provider)} test failed: ${error.message || error}`, `integration-${provider}`));
        }
    });
    router.post('/admin/settings/integrations/payments/:provider', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const provider = req.params.provider;
        if (!PAYMENT_PROVIDERS.includes(provider)) return res.status(404).send('Unknown provider');
        try {
            if (req.body.useEnvironment === '1') {
                await providerSettings.remove(provider, req.session.authUserId);
                return res.redirect(returnUrl(`${providerLabel(provider)} now uses environment fallback settings.`, '', `integration-${provider}`));
            }
            const input = provider === 'stripe'
                ? { enabled: checked(req.body.enabled), restrictedKey: req.body.restrictedKey, apiKey: req.body.apiKey, webhookSecret: req.body.webhookSecret, clearRestrictedKey: checked(req.body.clear_restrictedKey), clearApiKey: checked(req.body.clear_apiKey), clearWebhookSecret: checked(req.body.clear_webhookSecret) }
                : provider === 'plisio'
                    ? { enabled: checked(req.body.enabled), secretKey: req.body.secretKey, clearSecretKey: checked(req.body.clear_secretKey) }
                    : { enabled: checked(req.body.enabled), environment: req.body.environment, clientId: req.body.clientId, clientSecret: req.body.clientSecret, webhookId: req.body.webhookId, clearClientId: checked(req.body.clear_clientId), clearClientSecret: checked(req.body.clear_clientSecret), clearWebhookId: checked(req.body.clear_webhookId) };
            const status = await providerSettings.save(provider, input, req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.update','payment_provider',$2,$3::jsonb)`, [req.session.authUserId, provider, JSON.stringify({ enabled: status.enabled, configured: status.configured, webhookConfigured: status.webhookConfigured, environment: status.environment })]);
            return res.redirect(returnUrl(`${providerLabel(provider)} settings saved securely.`, '', `integration-${provider}`));
        } catch (error) {
            return res.redirect(returnUrl('', error.message || 'Payment settings could not be saved.', `integration-${provider}`));
        }
    });
    router.post('/admin/settings/integrations/email/settings', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (req.body.useEnvironment === '1') {
                await emailSettings.useEnvironment(req.session.authUserId);
                return res.redirect(returnUrl('Email gateway returned to environment fallback.', '', 'integration-email'));
            }
            const status = await emailSettings.status();
            const current = await emailSettings.get();
            const rawUsername = String(req.body.username || '').trim();
            const username = rawUsername === '••••••••' && status.source === 'browser' && status.usernameConfigured ? current.username : rawUsername;
            await emailSettings.save({ ...req.body, username }, req.session.authUserId);
            return res.redirect(returnUrl('Email gateway saved. Test the connection before relying on delivery.', '', 'integration-email'));
        } catch (error) {
            return res.redirect(returnUrl('', error.message || 'Email settings could not be saved.', 'integration-email'));
        }
    });
    router.post('/admin/settings/integrations/email/test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await emailSettings.testConnection();
            return res.redirect(returnUrl(`SMTP authenticated successfully in ${result.latencyMs} ms.`, '', 'integration-email'));
        } catch (error) {
            return res.redirect(returnUrl('', `SMTP test failed: ${error.message}`, 'integration-email'));
        }
    });
    router.post('/admin/settings/integrations/email/send-test', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const site = runtimeSettings.siteName();
            await emailSettings.send({ to: req.body.to, subject: `${site} email test`, text: `This is a test email from ${site}. Your SMTP gateway is working.`, html: `<p>This is a test email from <strong>${esc(site)}</strong>.</p><p>Your SMTP gateway is working.</p>` });
            return res.redirect(returnUrl('Test email sent successfully.', '', 'integration-email'));
        } catch (error) {
            return res.redirect(returnUrl('', `Test email failed: ${error.message}`, 'integration-email'));
        }
    });
    return router;
}

module.exports = { PAYMENT_PROVIDERS, webhookUrls, providerForm, emailForm, manager, paymentProviderSummary, registerRoutes, returnUrl };
