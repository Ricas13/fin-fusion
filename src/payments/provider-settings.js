'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const { encryptString, decryptString } = require('../crypto');

const PROVIDERS = ['stripe', 'paypal', 'coingate'];
const cache = new Map();
let loaded = false;
let loading = null;

function envConfig(provider) {
    if (provider === 'stripe') {
        const cfg = {
            source: 'environment',
            restrictedKey: process.env.STRIPE_RESTRICTED_KEY || '',
            apiKey: process.env.STRIPE_API_KEY || '',
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
        };
        cfg.enabled = process.env.STRIPE_ENABLED === 'false' ? false : Boolean(cfg.restrictedKey || cfg.apiKey);
        return cfg;
    }
    if (provider === 'coingate') {
        const cfg = {
            source: 'environment',
            environment: process.env.COINGATE_ENV === 'live' ? 'live' : 'sandbox',
            apiToken: process.env.COINGATE_API_TOKEN || '',
            callbackSecret: process.env.COINGATE_CALLBACK_SECRET || ''
        };
        cfg.enabled = process.env.COINGATE_ENABLED === 'false' ? false : Boolean(cfg.apiToken);
        return cfg;
    }
    const cfg = {
        source: 'environment',
        environment: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
        clientId: process.env.PAYPAL_CLIENT_ID || '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
        webhookId: process.env.PAYPAL_WEBHOOK_ID || ''
    };
    cfg.enabled = process.env.PAYPAL_ENABLED === 'false' ? false : Boolean(cfg.clientId && cfg.clientSecret);
    return cfg;
}

function credentialsConfigured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.restrictedKey || cfg?.apiKey);
    if (provider === 'coingate') return Boolean(cfg?.apiToken);
    return Boolean(cfg?.clientId && cfg?.clientSecret);
}

function configured(provider, cfg) {
    return Boolean(cfg?.enabled && credentialsConfigured(provider, cfg));
}

function webhookConfigured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.webhookSecret);
    if (provider === 'coingate') return Boolean(cfg?.callbackSecret && String(cfg.callbackSecret).length >= 32);
    return Boolean(cfg?.webhookId);
}

function decodeRow(row) {
    const secrets = JSON.parse(decryptString(row.secrets_encrypted) || '{}');
    const settings = row.settings || {};
    return {
        ...secrets,
        ...settings,
        // Existing browser-managed credentials predate the explicit switch.
        enabled: typeof settings.enabled === 'boolean' ? settings.enabled : credentialsConfigured(row.provider, secrets),
        source: 'database',
        updatedAt: row.updated_at || null
    };
}

async function load() {
    if (loading) return loading;
    loading = (async () => {
        const result = await query('SELECT provider,secrets_encrypted,settings,updated_at FROM payment_provider_credentials');
        const rows = new Map(result.rows.map(row => [row.provider, row]));
        for (const provider of PROVIDERS) {
            const row = rows.get(provider);
            cache.set(provider, row ? decodeRow(row) : envConfig(provider));
        }
        loaded = true;
    })().finally(() => { loading = null; });
    return loading;
}

async function ensureLoaded() {
    if (!loaded) await load();
    return true;
}

function raw(provider) {
    return cache.get(provider) || envConfig(provider);
}

// Runtime consumers use peek/get. Disabled gateways deliberately receive
// blank operational credentials while the encrypted values stay stored, so
// toggling a provider off is reversible without deleting secrets.
function effective(provider, cfg) {
    if (cfg?.enabled !== false) return cfg;
    if (provider === 'stripe') return { ...cfg, restrictedKey: '', apiKey: '', webhookSecret: '' };
    if (provider === 'coingate') return { ...cfg, apiToken: '', callbackSecret: '' };
    return { ...cfg, clientId: '', clientSecret: '', webhookId: '' };
}

function peek(provider) {
    return effective(provider, raw(provider));
}

async function get(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    await ensureLoaded();
    return peek(provider);
}

async function getRaw(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    await ensureLoaded();
    return raw(provider);
}

async function status(provider) {
    const cfg = await getRaw(provider);
    return {
        provider,
        source: cfg.source || 'environment',
        enabled: Boolean(cfg.enabled),
        credentialsConfigured: credentialsConfigured(provider, cfg),
        configured: configured(provider, cfg),
        webhookConfigured: webhookConfigured(provider, cfg),
        environment: ['paypal', 'coingate'].includes(provider) ? (cfg.environment === 'live' ? 'live' : 'sandbox') : null,
        updatedAt: cfg.updatedAt || null
    };
}

function clean(value, max = 1000) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

async function save(provider, input, actorUserId = null) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    const current = await getRaw(provider);
    let secrets;
    let settings = { enabled: input.enabled !== false };

    if (provider === 'stripe') {
        secrets = {
            restrictedKey: input.clearRestrictedKey ? '' : (clean(input.restrictedKey) || current.restrictedKey || ''),
            apiKey: input.clearApiKey ? '' : (clean(input.apiKey) || current.apiKey || ''),
            webhookSecret: input.clearWebhookSecret ? '' : (clean(input.webhookSecret) || current.webhookSecret || '')
        };
    } else if (provider === 'coingate') {
        const callbackSecret = clean(current.callbackSecret, 256) || crypto.randomBytes(32).toString('hex');
        secrets = {
            apiToken: input.clearApiToken ? '' : (clean(input.apiToken, 2000) || current.apiToken || ''),
            callbackSecret
        };
        settings = { ...settings, environment: input.environment === 'live' ? 'live' : 'sandbox' };
    } else {
        secrets = {
            clientId: input.clearClientId ? '' : (clean(input.clientId) || current.clientId || ''),
            clientSecret: input.clearClientSecret ? '' : (clean(input.clientSecret) || current.clientSecret || ''),
            webhookId: input.clearWebhookId ? '' : (clean(input.webhookId) || current.webhookId || '')
        };
        settings = { ...settings, environment: input.environment === 'live' ? 'live' : 'sandbox' };
    }

    await query(`
        INSERT INTO payment_provider_credentials(provider,secrets_encrypted,settings,updated_by)
        VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(provider) DO UPDATE SET
            secrets_encrypted=EXCLUDED.secrets_encrypted,
            settings=EXCLUDED.settings,
            updated_by=EXCLUDED.updated_by,
            updated_at=NOW()
    `, [provider, encryptString(JSON.stringify(secrets)), JSON.stringify(settings), actorUserId]);

    cache.set(provider, { ...secrets, ...settings, source: 'database', updatedAt: new Date() });
    loaded = true;
    return status(provider);
}

async function remove(provider, actorUserId = null) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    await query('DELETE FROM payment_provider_credentials WHERE provider=$1', [provider]);
    cache.set(provider, envConfig(provider));
    loaded = true;
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'admin.payment_credentials.use_environment','payment_provider',$2,'{}'::jsonb)
    `, [actorUserId, provider]);
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Connection timed out after 10 seconds.');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function testStripe(cfg) {
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) throw new Error('Stripe API credentials are not configured.');
    const response = await fetchWithTimeout('https://api.stripe.com/v1/prices?limit=1', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error(body?.error?.message || 'Stripe rejected the API key.');
    if (response.status === 403) {
        const detail = clean(body?.error?.message, 500);
        const suffix = 'Check Prices: Read and any IP/network restrictions configured on the restricted key.';
        return {
            ok: true,
            limited: true,
            message: detail
                ? `Stripe denied the Prices request (HTTP 403): ${detail} ${suffix}`
                : `Stripe denied the Prices request (HTTP 403). ${suffix}`
        };
    }
    if (!response.ok) throw new Error(body?.error?.message || `Stripe returned HTTP ${response.status}.`);
    return { ok: true, limited: false, message: 'Stripe connection successful. API credentials were accepted.' };
}

async function testPayPal(cfg) {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal client ID and secret are not configured.');
    const host = cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const response = await fetchWithTimeout(`${host}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.access_token) {
        throw new Error(body?.error_description || body?.message || `PayPal returned HTTP ${response.status}.`);
    }
    return {
        ok: true,
        limited: false,
        message: `PayPal ${cfg.environment === 'live' ? 'Live' : 'Sandbox'} connection successful. Client credentials were accepted.`
    };
}

async function testCoinGate(cfg) {
    if (!cfg.apiToken) throw new Error('CoinGate API token is not configured.');
    const host = cfg.environment === 'live' ? 'https://api.coingate.com' : 'https://api-sandbox.coingate.com';
    const response = await fetchWithTimeout(`${host}/v2/auth/test`, {
        method: 'GET',
        headers: { Authorization: `Token ${cfg.apiToken}`, Accept: 'application/json' }
    });
    const text = await response.text();
    let body = {};
    if (text) { try { body = JSON.parse(text); } catch (_) { body = { message: text }; } }
    if (!response.ok) throw new Error(body?.message || body?.error || `CoinGate returned HTTP ${response.status}.`);
    return {
        ok: true,
        limited: false,
        message: `CoinGate ${cfg.environment === 'live' ? 'Live' : 'Sandbox'} connection successful. API token was accepted.`
    };
}

async function testConnection(provider) {
    const cfg = await getRaw(provider);
    if (provider === 'stripe') return testStripe(cfg);
    if (provider === 'coingate') return testCoinGate(cfg);
    return testPayPal(cfg);
}

module.exports = {
    PROVIDERS,
    ensureLoaded,
    get,
    getRaw,
    peek,
    status,
    save,
    remove,
    configured,
    credentialsConfigured,
    webhookConfigured,
    testConnection
};