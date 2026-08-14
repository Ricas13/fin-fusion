'use strict';

const { query } = require('../db');
const { encryptString, decryptString } = require('../crypto');

const PROVIDERS = ['stripe', 'paypal'];
const cache = new Map();
let loaded = false;
let loading = null;

function envConfig(provider) {
    if (provider === 'stripe') {
        return {
            source: 'environment',
            restrictedKey: process.env.STRIPE_RESTRICTED_KEY || '',
            apiKey: process.env.STRIPE_API_KEY || '',
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
        };
    }
    return {
        source: 'environment',
        environment: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
        clientId: process.env.PAYPAL_CLIENT_ID || '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
        webhookId: process.env.PAYPAL_WEBHOOK_ID || ''
    };
}

function configured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.restrictedKey || cfg?.apiKey);
    return Boolean(cfg?.clientId && cfg?.clientSecret);
}

function webhookConfigured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.webhookSecret);
    return Boolean(cfg?.webhookId);
}

function decodeRow(row) {
    const secrets = JSON.parse(decryptString(row.secrets_encrypted) || '{}');
    return {
        ...secrets,
        ...(row.settings || {}),
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

function peek(provider) {
    return cache.get(provider) || envConfig(provider);
}

async function get(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    await ensureLoaded();
    return peek(provider);
}

async function status(provider) {
    const cfg = await get(provider);
    return {
        provider,
        source: cfg.source || 'environment',
        configured: configured(provider, cfg),
        webhookConfigured: webhookConfigured(provider, cfg),
        environment: provider === 'paypal' ? (cfg.environment === 'live' ? 'live' : 'sandbox') : null,
        updatedAt: cfg.updatedAt || null
    };
}

function clean(value, max = 1000) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

async function save(provider, input, actorUserId = null) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unsupported payment provider');
    const current = await get(provider);
    let secrets;
    let settings = {};

    if (provider === 'stripe') {
        secrets = {
            restrictedKey: input.clearRestrictedKey ? '' : (clean(input.restrictedKey) || current.restrictedKey || ''),
            apiKey: input.clearApiKey ? '' : (clean(input.apiKey) || current.apiKey || ''),
            webhookSecret: input.clearWebhookSecret ? '' : (clean(input.webhookSecret) || current.webhookSecret || '')
        };
    } else {
        secrets = {
            clientId: input.clearClientId ? '' : (clean(input.clientId) || current.clientId || ''),
            clientSecret: input.clearClientSecret ? '' : (clean(input.clientSecret) || current.clientSecret || ''),
            webhookId: input.clearWebhookId ? '' : (clean(input.webhookId) || current.webhookId || '')
        };
        settings = { environment: input.environment === 'live' ? 'live' : 'sandbox' };
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

module.exports = {
    ensureLoaded,
    get,
    peek,
    status,
    save,
    remove,
    configured,
    webhookConfigured
};
