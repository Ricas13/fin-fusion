'use strict';

const { query } = require('../db');
const runtimeSettings = require('./runtime-settings');
const providerSettings = require('../payments/provider-settings');
const requestServiceSettings = require('../integrations/request-service-settings');
const emailSettings = require('../integrations/email-settings');

function envPresent(...names) {
    return names.some(name => Boolean(String(process.env[name] || '').trim()));
}

async function setupReadiness() {
    await Promise.all([runtimeSettings.ensureLoaded(), providerSettings.ensureLoaded(), requestServiceSettings.ensureLoaded()]);

    const [counts, providerMappings, settings, activeDiscounts, stripeStatus, paypalStatus, requestStatus, emailStatus] = await Promise.all([
        query(`
            SELECT
                (SELECT COUNT(*)::int FROM jellyfin_servers) AS servers,
                (SELECT COUNT(*)::int FROM plans) AS plans,
                (SELECT COUNT(*)::int FROM customers) AS customers,
                (SELECT COUNT(*)::int FROM resellers) AS resellers,
                (SELECT COUNT(*)::int FROM subscriptions) AS subscriptions
        `),
        query(`
            SELECT provider,COUNT(*)::int AS mappings
            FROM plan_provider_prices
            WHERE active=TRUE
            GROUP BY provider
        `),
        query(`
            SELECT setting_key,setting_value
            FROM platform_settings
            WHERE setting_key IN ('referral_program','installation')
        `),
        query(`SELECT COUNT(*)::int AS count FROM discount_codes WHERE active=TRUE`),
        providerSettings.status('stripe'),
        providerSettings.status('paypal'),
        requestServiceSettings.status(),
        emailSettings.status()
    ]);

    const c = counts.rows[0] || {};
    const mappingByProvider = Object.fromEntries(providerMappings.rows.map(row => [row.provider, Number(row.mappings || 0)]));
    const settingMap = Object.fromEntries(settings.rows.map(row => [row.setting_key, row.setting_value || {}]));

    const stripeReady = stripeStatus.configured && Number(mappingByProvider.stripe || 0) > 0;
    const paypalReady = paypalStatus.configured && Number(mappingByProvider.paypal || 0) > 0;
    const emailReady = emailStatus.configured;
    const telegramReady = envPresent('TELEGRAM_BOT_TOKEN') && envPresent('TELEGRAM_CHAT_ID');
    const whatsappReady = envPresent('WHATSAPP_PROVIDER') && envPresent('WHATSAPP_ACCESS_TOKEN');
    const notificationsReady = emailReady || telegramReady || whatsappReady;
    const storefrontEnabled = runtimeSettings.storefrontEnabled();
    const registrationEnabled = runtimeSettings.publicRegistrationOpen();
    const referralsEnabled = settingMap.referral_program?.enabled === true;
    const requestReady = requestStatus.configured;

    const checklist = [
        {
            key: 'jellyfin',
            label: 'Add first Jellyfin server',
            configured: Number(c.servers || 0) > 0,
            detail: Number(c.servers || 0) > 0 ? `${c.servers} server${Number(c.servers) === 1 ? '' : 's'} configured` : 'No Jellyfin server configured yet',
            href: '/admin/servers/new'
        },
        {
            key: 'plans',
            label: 'Create first plan',
            configured: Number(c.plans || 0) > 0,
            detail: Number(c.plans || 0) > 0 ? `${c.plans} plan${Number(c.plans) === 1 ? '' : 's'} configured` : 'No commercial or trial plans exist',
            href: '/admin/plans'
        },
        {
            key: 'payments',
            label: 'Configure payments',
            configured: stripeReady || paypalReady,
            detail: stripeReady || paypalReady
                ? [stripeReady ? 'Stripe' : null, paypalReady ? 'PayPal' : null].filter(Boolean).join(' + ') + ' ready'
                : 'Optional · enable a provider, save credentials and map it to a plan',
            href: '/admin/payments'
        },
        {
            key: 'requests',
            label: 'Configure request service',
            configured: requestReady,
            detail: requestReady ? `Central request service ready · ${requestStatus.baseUrl}` : 'Optional · add URL and API key under Provisioning → Request Service',
            href: '/admin/request-users'
        },
        {
            key: 'email',
            label: 'Configure email',
            configured: emailReady,
            detail: emailReady ? `Transactional email ready · ${emailStatus.source === 'browser' ? 'browser managed' : 'environment fallback'}` : 'Optional · configure SMTP under Notifications',
            href: '/admin/notifications'
        },
        {
            key: 'notifications',
            label: 'Configure notifications',
            configured: notificationsReady,
            detail: notificationsReady
                ? [telegramReady ? 'Telegram' : null, emailReady ? 'Email' : null, whatsappReady ? 'WhatsApp' : null].filter(Boolean).join(' + ')
                : 'Optional · no delivery channel configured',
            href: '/admin/notifications'
        },
        {
            key: 'storefront',
            label: 'Configure storefront / registration',
            configured: storefrontEnabled || registrationEnabled,
            detail: storefrontEnabled
                ? `Storefront enabled · registration ${registrationEnabled ? 'open' : 'closed'}`
                : `Storefront disabled · registration ${registrationEnabled ? 'open' : 'closed'}`,
            href: '/admin/settings'
        }
    ];

    const modules = [
        { name: 'Customers', state: 'enabled', detail: `${Number(c.customers || 0)} customer${Number(c.customers) === 1 ? '' : 's'}` },
        { name: 'Resellers', state: 'enabled', detail: `${Number(c.resellers || 0)} reseller${Number(c.resellers) === 1 ? '' : 's'}` },
        { name: 'Jellyfin', state: Number(c.servers || 0) > 0 ? 'configured' : 'not_configured', detail: `${Number(c.servers || 0)} servers` },
        { name: 'Stripe', state: stripeStatus.enabled ? (stripeStatus.configured ? 'configured' : 'not_configured') : 'disabled', detail: stripeStatus.configured ? `${mappingByProvider.stripe || 0} plan mapping(s)` : 'Optional' },
        { name: 'PayPal', state: paypalStatus.enabled ? (paypalStatus.configured ? 'configured' : 'not_configured') : 'disabled', detail: paypalStatus.configured ? `${mappingByProvider.paypal || 0} plan mapping(s)` : 'Optional' },
        { name: 'Request service', state: requestStatus.enabled ? (requestReady ? 'configured' : 'not_configured') : 'disabled', detail: requestReady ? requestStatus.baseUrl : 'Optional' },
        { name: 'Email', state: emailStatus.enabled ? (emailReady ? 'configured' : 'not_configured') : 'disabled', detail: emailReady ? `${emailStatus.host}:${emailStatus.port}` : 'Optional' },
        { name: 'Storefront', state: storefrontEnabled ? 'enabled' : 'disabled', detail: storefrontEnabled ? 'Public homepage enabled' : 'Opt-in' },
        { name: 'Registration', state: registrationEnabled ? 'enabled' : 'disabled', detail: registrationEnabled ? 'Public registration open' : 'Invite/admin onboarding only' },
        { name: 'Notifications', state: notificationsReady ? 'configured' : 'not_configured', detail: notificationsReady ? 'Delivery channel ready' : 'Optional' },
        { name: 'Referrals', state: referralsEnabled ? 'enabled' : 'disabled', detail: referralsEnabled ? 'Reward program enabled' : 'Opt-in' },
        { name: 'Discounts', state: Number(activeDiscounts.rows[0]?.count || 0) > 0 ? 'enabled' : 'available', detail: `${Number(activeDiscounts.rows[0]?.count || 0)} active` }
    ];

    return {
        checklist,
        configuredCount: checklist.filter(item => item.configured).length,
        totalCount: checklist.length,
        modules,
        counts: {
            servers: Number(c.servers || 0),
            plans: Number(c.plans || 0),
            customers: Number(c.customers || 0),
            resellers: Number(c.resellers || 0),
            subscriptions: Number(c.subscriptions || 0)
        },
        cleanInstall: settingMap.installation?.cleanInstall === true
    };
}

module.exports = { setupReadiness, envPresent };
