'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const plans=read('src/platform/admin-plans-list.js');
const shell=read('src/platform/admin-html-core.js');
const settings=read('src/integrations/notification-settings.js');
const dispatch=read('src/integrations/notification-dispatch.js');
const outbox=read('src/integrations/notification-outbox.js');
const communications=read('src/platform/customer-communications.js');
const registration=read('views/customer/register.ejs');
const adminNotifications=read('src/platform/admin-notification-preferences.js');
const migration=read('db/migrations/075_customer_bot_channels.sql');

assert(!/FROM reseller_tiers WHERE archived_at IS NULL/.test(plans),'Plans list must not query nonexistent reseller_tiers.archived_at');
assert(plans.includes("readiness.context().catch"),'Plans must degrade readiness telemetry independently');
assert(plans.includes("resellerRows().catch"),'Plans must degrade reseller summary independently');
assert(shell.includes("paymentWorkflow.tabs(active)"),'Shared admin shell must render payment workflow tabs');
for(const title of ['Payments','Provider mappings','Billing'])assert(shell.includes(`'${title}'`),`Payment workflow must recognise ${title}`);

assert(settings.includes("/users/@me/channels"),'Discord delivery must use the bot DM API');
assert(settings.includes("scope','identify")===false,'Discord OAuth scope belongs in customer linking route, not notification settings');
assert(!settings.includes('discordWebhookUrl'),'Discord delivery must not depend on a webhook URL');
assert(settings.includes("exchangeDiscordCode"),'Discord OAuth identity exchange must be implemented');
assert(settings.includes("configureTelegramWebhook"),'Telegram bot update endpoint must be configured through the Bot API');
assert(communications.includes("https://t.me/"),'Telegram customer linking must use a bot deep link');
assert(communications.includes("scope','identify"),'Discord customer linking must request only identify');
assert(communications.includes("x-telegram-bot-api-secret-token"),'Telegram bot update endpoint must verify the Bot API secret token');
assert(dispatch.includes('telegram_chat_id'),'Customer Telegram delivery must use the verified chat id');
assert(dispatch.includes('discord_user_id'),'Customer Discord delivery must use the verified user id');
assert(outbox.includes("settings.sendDiscord")&&outbox.includes("userId:row.destination"),'Outbox must pass each Discord destination to bot DM delivery');
assert(registration.includes('name="whatsappOptIn"')&&registration.includes('name="telegramOptIn"')&&registration.includes('name="discordOptIn"'),'Registration must collect secondary-channel preferences');
assert(registration.includes('international phone number'),'Registration must explain WhatsApp destination requirements');
assert(adminNotifications.includes('Discord bot')&&!adminNotifications.includes('Webhook URL'),'Admin notification setup must be bot-first');
assert(migration.includes('telegram_chat_id')&&migration.includes('discord_user_id')&&migration.includes('customer_channel_link_tokens'),'Migration must persist verified bot identities and short-lived link tokens');

console.log('customer bot + commerce regression smoke: ok');
