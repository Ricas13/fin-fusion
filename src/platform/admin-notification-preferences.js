'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const operations = require('./operations-settings');
const emailSettings = require('../integrations/email-settings');
const notificationSettings = require('../integrations/notification-settings');
const notificationOutbox = require('../integrations/notification-outbox');
const { layout, esc } = require('./admin-html');
const {
    page: profilePage,
    data: adminProfileData
} = require('./admin-personal-notification-preferences-v2');

function gate(req, res, next) {
    return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId
        ? next()
        : res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function token(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function label(eventType) {
    return String(eventType || '')
        .split('.')
        .map(part => part.replace(/_/g, ' '))
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' · ');
}

function group(eventType) {
    const first = String(eventType || '').split('.')[0];
    return ({
        customer: 'Customer', subscription: 'Subscription', payment: 'Payments',
        server: 'Servers', request: 'Requests', automation: 'Automation',
        security: 'Security', account: 'Account'
    })[first] || 'Platform';
}

function dt(value) {
    return value ? new Date(value).toLocaleString('en-GB') : '—';
}

async function rows() {
    const result = await query(`
        SELECT event_type,event_scope,customer_opt_in_allowed,
               COALESCE(display_name,event_type) display_name,
               COALESCE(description,'') description,
               telegram_enabled,email_enabled,discord_enabled,whatsapp_enabled,updated_at
        FROM notification_preferences
        ORDER BY event_type
    `);
    return result.rows;
}

function ready(labelValue, ok) {
    return `<span class="statusPill ${ok ? 'statusGood' : 'statusWarn'}">${esc(labelValue)} ${ok ? 'ready' : 'not configured'}</span>`;
}

function secret(name, placeholder, configured, clearName) {
    return `<input class="input" type="password" name="${esc(name)}" autocomplete="new-password" placeholder="${configured ? 'Configured — leave blank to keep' : esc(placeholder)}"><label class="checkRow"><input type="checkbox" name="${esc(clearName)}"> Clear saved secret</label>`;
}

function endpointField(labelValue, value, help) {
    return `<label>${esc(labelValue)}</label><input class="input" value="${esc(value)}" readonly><div class="muted">${esc(help)}</div>`;
}

async function channelCounts() {
    const result = await query(`
        SELECT COUNT(*) FILTER(WHERE telegram_chat_id IS NOT NULL)::int telegram,
               COUNT(*) FILTER(WHERE discord_user_id IS NOT NULL)::int discord,
               COUNT(*) FILTER(WHERE whatsapp_opt_in=TRUE AND phone_e164 IS NOT NULL)::int whatsapp
        FROM customer_communication_preferences
    `);
    return result.rows[0] || { telegram: 0, discord: 0, whatsapp: 0 };
}

function scopePill(row) {
    const text = row.event_scope === 'both'
        ? 'Admin + customer'
        : row.event_scope === 'customer' ? 'Customer' : 'Admin only';
    return `<span class="pill ${row.event_scope === 'admin' ? 'warn' : 'accent'}">${esc(text)}</span>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [events, email, delivery, recent, counts, telegramEndpoint, discordRedirectUri] = await Promise.all([
        rows(),
        emailSettings.status().catch(() => ({ configured: false })),
        notificationSettings.status().catch(() => ({})),
        notificationOutbox.recent(80).catch(() => []),
        channelCounts().catch(() => ({ telegram: 0, discord: 0, whatsapp: 0 })),
        operations.absoluteUrl(req, '/integrations/telegram/bot', { requireCanonical: false }),
        operations.absoluteUrl(req, '/account/communications/discord/callback', { requireCanonical: false })
    ]);

    const groups = new Map();
    for (const row of events) {
        const key = group(row.event_type);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    const body = `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}
    <div class="operatorCallout"><strong>Global notification control centre.</strong> This page controls platform capabilities, bot/API credentials, platform-wide channel availability and the event catalogue. Individual administrators choose their own recipients under <a href="/admin/profile/notifications">My notification preferences</a>. Customer accounts can only opt into events explicitly marked as customer-allowed below.</div>
    <div class="buttonRow" style="margin:14px 0">${ready('Email', email.configured)} ${ready('Telegram bot', delivery.telegramConfigured)} ${ready('Discord bot', delivery.discordConfigured)} ${ready('WhatsApp', delivery.whatsappConfigured)} <a class="button secondary" href="/admin/email">Email infrastructure</a><a class="button secondary" href="/admin/profile/notifications">My notification preferences</a></div>
    <div class="metrics"><div class="metric"><div class="metricLabel">Linked Telegram customers</div><div class="metricValue">${esc(counts.telegram || 0)}</div></div><div class="metric"><div class="metricLabel">Linked Discord customers</div><div class="metricValue">${esc(counts.discord || 0)}</div></div><div class="metric"><div class="metricLabel">WhatsApp opt-ins</div><div class="metricValue">${esc(counts.whatsapp || 0)}</div></div></div>
    <section class="section"><div class="sectionHead"><div><h2>Messaging applications</h2><div class="muted">Platform credentials are shared infrastructure. Recipient identities are stored per administrator/customer.</div></div></div><form class="formPanel" method="post" action="/admin/notifications/preferences/delivery">${token(req)}<div class="formGrid">
    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="telegramEnabled" ${delivery.telegramEnabled ? 'checked' : ''}><span><strong>Telegram bot</strong></span></label><label>Bot token</label>${secret('telegramToken', '123456:ABC…', delivery.telegramTokenConfigured, 'clearTelegramToken')}<label>Bot username</label><input class="input" name="telegramBotUsername" value="${esc(delivery.telegramBotUsername || '')}" placeholder="CaptainFinBot">${endpointField('Bot API update endpoint', telegramEndpoint, 'CAPTAiNFiN registers this endpoint with Telegram when you save the bot.')}<label>Legacy global destination <span class="muted">(manual/tests only)</span></label><input class="input" name="telegramAdminChatId" value="${esc(delivery.telegramAdminChatId || '')}" placeholder="Event fan-out does not use this"></div>
    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="discordEnabled" ${delivery.discordEnabled ? 'checked' : ''}><span><strong>Discord bot</strong></span></label><label>Bot token</label>${secret('discordBotToken', 'Discord bot token', delivery.discordBotTokenConfigured, 'clearDiscordBotToken')}<label>Application client ID</label><input class="input" name="discordClientId" value="${esc(delivery.discordClientId || '')}" placeholder="Discord application ID"><label>OAuth client secret</label>${secret('discordClientSecret', 'Discord OAuth client secret', delivery.discordClientSecretConfigured, 'clearDiscordClientSecret')}${endpointField('Customer OAuth redirect URI', discordRedirectUri, 'Add the customer and admin profile redirect URIs to the Discord application.')}<label>Legacy global destination <span class="muted">(manual/tests only)</span></label><input class="input" name="discordAdminUserId" value="${esc(delivery.discordAdminUserId || '')}" placeholder="Event fan-out does not use this"></div>
    <div class="formGroup"><label class="toggleRow"><input type="checkbox" name="whatsappEnabled" ${delivery.whatsappEnabled ? 'checked' : ''}><span><strong>WhatsApp Cloud API</strong></span></label><label>Cloud API token</label>${secret('whatsappAccessToken', 'Meta Cloud API access token', delivery.whatsappTokenConfigured, 'clearWhatsappToken')}<label>Phone number ID</label><input class="input" name="whatsappPhoneNumberId" value="${esc(delivery.whatsappPhoneNumberId || '')}" placeholder="Meta phone number ID"><label>Approved notification template</label><input class="input" name="whatsappTemplateName" value="${esc(delivery.whatsappTemplateName || '')}" placeholder="captainfin_notification"><label>Template language</label><input class="input" name="whatsappTemplateLanguage" value="${esc(delivery.whatsappTemplateLanguage || 'en_US')}"></div>
    </div><div class="buttonRow"><button class="button">Save messaging apps</button><button class="button secondary" formaction="/admin/notifications/preferences/test-telegram">Validate Telegram bot</button><button class="button secondary" formaction="/admin/notifications/preferences/test-discord">Validate Discord bot</button></div></form></section>
    <form method="post" action="/admin/notifications/preferences">${token(req)}${[...groups.entries()].map(([name, list]) => `<section class="section"><div class="sectionHead"><h2>${esc(name)}</h2><span class="muted">${list.length} event type(s)</span></div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Event</th><th>Audience</th><th>Email</th><th>Telegram</th><th>Discord</th><th>WhatsApp</th><th>Customer opt-in</th></tr></thead><tbody>${list.map(row => `<tr><td><strong>${esc(row.display_name || label(row.event_type))}</strong><div class="muted">${esc(row.description || row.event_type)}</div><code>${esc(row.event_type)}</code></td><td>${scopePill(row)}</td><td><input type="checkbox" name="email__${esc(row.event_type)}" ${row.email_enabled ? 'checked' : ''}></td><td><input type="checkbox" name="telegram__${esc(row.event_type)}" ${row.telegram_enabled ? 'checked' : ''}></td><td><input type="checkbox" name="discord__${esc(row.event_type)}" ${row.discord_enabled ? 'checked' : ''}></td><td><input type="checkbox" name="whatsapp__${esc(row.event_type)}" ${row.whatsapp_enabled ? 'checked' : ''}></td><td>${row.event_scope === 'admin' ? '<span class="muted">Never exposed</span>' : `<input type="checkbox" name="customer_allowed__${esc(row.event_type)}" ${row.customer_opt_in_allowed ? 'checked' : ''}>`}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}<div class="buttonRow"><button class="button">Save global event catalogue</button></div></form>
    <section class="section"><div class="sectionHead"><h2>Global templates & delivery history</h2><span class="muted">Templates remain event-key based; recent outbox deliveries are shown below.</span></div>${recent.length ? `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Created</th><th>Channel</th><th>Event</th><th>Destination</th><th>Status</th><th>Attempts</th><th>Last error</th><th></th></tr></thead><tbody>${recent.map(row => `<tr><td>${esc(dt(row.created_at))}</td><td><span class="pill">${esc(row.channel)}</span></td><td><code>${esc(row.event_type || row.message_type)}</code></td><td><code>${esc(row.destination ? String(row.destination).slice(0, 32) : '—')}</code></td><td><span class="pill ${row.status === 'sent' ? 'good' : row.status === 'dead' ? 'bad' : row.status === 'failed' ? 'warn' : ''}">${esc(row.status)}</span></td><td>${esc(row.attempts)}</td><td>${esc(row.last_error || '—')}</td><td>${['failed', 'dead'].includes(row.status) ? `<form method="post" action="/admin/notifications/preferences/outbox/${esc(row.id)}/retry">${token(req)}<button class="button secondary btn-sm">Retry now</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No secondary-channel delivery attempts yet.</div>'}</section>`;

    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'notifications',
        title: 'Notifications',
        subtitle: 'Global infrastructure, channel availability and event permissions',
        body
    });
}

function createAdminNotificationPreferencesRouter() {
    const router = express.Router();
    router.use('/admin/notifications/preferences', gate, noStore);

    router.get('/admin/notifications/preferences', async (req, res, next) => {
        try { return res.send(await page(req)); }
        catch (error) { return next(error); }
    });

    router.post('/admin/notifications/preferences', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const events = await rows();
            await transaction(async client => {
                for (const row of events) {
                    const email = String(req.body[`email__${row.event_type}`] || '') === 'on';
                    const telegram = String(req.body[`telegram__${row.event_type}`] || '') === 'on';
                    const discord = String(req.body[`discord__${row.event_type}`] || '') === 'on';
                    const whatsapp = String(req.body[`whatsapp__${row.event_type}`] || '') === 'on';
                    const customerAllowed = row.event_scope !== 'admin' && String(req.body[`customer_allowed__${row.event_type}`] || '') === 'on';
                    await client.query(`
                        UPDATE notification_preferences
                        SET email_enabled=$2,telegram_enabled=$3,discord_enabled=$4,whatsapp_enabled=$5,
                            customer_opt_in_allowed=$6,updated_by=$7,updated_at=NOW()
                        WHERE event_type=$1
                    `, [row.event_type, email, telegram, discord, whatsapp, customerAllowed, req.session.authUserId]);
                }
                await client.query(`
                    INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                    VALUES($1,'admin.notifications.global.update','notification_preferences','all',$2::jsonb)
                `, [req.session.authUserId, JSON.stringify({ eventCount: events.length })]);
            });
            return res.redirect('/admin/notifications/preferences?message=' + encodeURIComponent('Global notification catalogue saved.'));
        } catch (error) {
            return res.redirect('/admin/notifications/preferences?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/notifications/preferences/delivery', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const saved = await notificationSettings.save(req.body, req.session.authUserId);
            if (saved.telegramEnabled) {
                const webhook = await operations.absoluteUrl(req, '/integrations/telegram/bot', { requireCanonical: false });
                await notificationSettings.configureTelegramWebhook(webhook);
            }
            return res.redirect('/admin/notifications/preferences?message=' + encodeURIComponent('Messaging applications saved.'));
        } catch (error) {
            return res.redirect('/admin/notifications/preferences?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/notifications/preferences/test-telegram', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (Object.keys(req.body || {}).length) await notificationSettings.save(req.body, req.session.authUserId);
            const result = await notificationSettings.testTelegram();
            return res.redirect('/admin/notifications/preferences?message=' + encodeURIComponent(`Telegram bot ${result.identity} validated in ${result.latencyMs} ms.`));
        } catch (error) {
            return res.redirect('/admin/notifications/preferences?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/notifications/preferences/test-discord', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            if (Object.keys(req.body || {}).length) await notificationSettings.save(req.body, req.session.authUserId);
            const result = await notificationSettings.testDiscord();
            return res.redirect('/admin/notifications/preferences?message=' + encodeURIComponent(`Discord bot ${result.identity} validated in ${result.latencyMs} ms.`));
        } catch (error) {
            return res.redirect('/admin/notifications/preferences?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/notifications/preferences/outbox/:id/retry', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const ok = await notificationOutbox.retry(req.params.id);
            return res.redirect('/admin/notifications/preferences?message=' + encodeURIComponent(ok ? 'Delivery queued for retry.' : 'Nothing was eligible for retry.'));
        } catch (error) {
            return res.redirect('/admin/notifications/preferences?error=' + encodeURIComponent(error.message));
        }
    });

    return router;
}

module.exports = {
    createAdminNotificationPreferencesRouter,
    page,
    rows,
    channelCounts,
    // Compatibility exports now delegate to the one canonical personal module.
    profilePage,
    adminProfileData
};
