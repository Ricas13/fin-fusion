'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const nav=require('../src/platform/admin-nav');
const adminShell=require('../src/platform/admin-html-core-base');

const plans=read('src/platform/admin-plans-list.js');
const settings=read('src/integrations/notification-settings.js');
const dispatch=read('src/integrations/notification-dispatch.js');
const outbox=read('src/integrations/notification-outbox.js');
const communications=read('src/platform/customer-communications.js');
const adminLinks=read('src/integrations/admin-channel-links.js');
const registration=read('views/customer/register.ejs');
const communicationView=read('views/customer/communications.ejs');
const adminNotifications=read('src/platform/admin-notification-preferences.js');
const operations=read('src/platform/operations-settings.js');
const orders=read('src/platform/admin-orders.js');
const referrals=read('src/platform/admin-referrals.js');
const baseline=read('db/migrations/000_database_baseline.sql');

assert(plans.includes("readiness.context().catch"),'Plans must degrade readiness telemetry independently');
assert(!/credit wallet|buy credits/i.test(plans),'Unified Plans must not revive retired-product credit semantics');
for(const title of ['Payments','Provider mappings','Billing','Payment Risk Policy','Payment History','Migrate paid users'])assert.strictEqual(adminShell.paymentTabsFor({title}),'',`Shared admin shell must not render a payment workflow tab row for ${title}`);
assert.deepStrictEqual(
  nav.childPages('payments').map(page=>page[1]),
  ['Billing','Expenses & Profitability','Provider mappings','Migrate paid users','Import history','Payment risk'],
  'Payments & Billing must expose every durable payment workflow directly in the sidebar'
);

assert(settings.includes("/users/@me/channels"),'Discord delivery must use the bot DM API');
assert(!settings.includes("scope','identify"),'Discord OAuth scope belongs in linking routes, not notification settings');
assert(!settings.includes('discordWebhookUrl'),'Discord delivery must not depend on a webhook URL');
assert(settings.includes("exchangeDiscordCode"),'Discord OAuth identity exchange must be implemented');
assert(settings.includes("configureTelegramWebhook"),'Telegram bot update endpoint must be configured through the Bot API');
assert(communications.includes('telegramBotUsername')&&communications.includes('?start=${encodeURIComponent(issued.token)}'),'Telegram customer linking must build a bot deep link from configured bot identity plus an encoded one-time token');
assert(communications.includes("r.post('/account/communications/telegram/start'"),'Telegram bot linking must start from a CSRF-protected POST');
assert(communications.includes("r.post('/account/communications/discord/start'"),'Discord OAuth linking must start from a CSRF-protected POST');
assert(communicationView.includes('method="post" action="/account/communications/telegram/start"'),'Telegram connect UI must submit a POST');
assert(communicationView.includes('method="post" action="/account/communications/discord/start"'),'Discord connect UI must submit a POST');
assert(communications.includes("scope','identify"),'Discord customer linking must request only identify');
assert(communications.includes("x-telegram-bot-api-secret-token"),'Telegram bot update endpoint must verify the Bot API secret token');
assert(dispatch.includes('telegram_chat_id'),'Customer Telegram delivery must use the verified chat id');
assert(dispatch.includes('discord_user_id'),'Customer Discord delivery must use the verified user id');
assert(dispatch.includes('customerEventEnabled(customerId,eventType'),'Customer optional delivery must check the exact event/channel opt-in');
assert(dispatch.includes("if(['admin','both'].includes(pref.event_scope))await queueAdmins"),'Shared events must fan out to independently opted-in admins as well as the customer');
assert(!/customer.*telegramAdminChatId/i.test(dispatch),'Customer delivery must never fall back to the legacy admin Telegram destination');
assert(!/customer.*discordAdminUserId/i.test(dispatch),'Customer delivery must never fall back to the legacy admin Discord destination');
assert(outbox.includes("settings.sendDiscord")&&outbox.includes("userId:row.destination"),'Outbox must pass each Discord destination to bot DM delivery');
assert(registration.includes('name="whatsappOptIn"')&&registration.includes('name="telegramOptIn"')&&registration.includes('name="discordOptIn"'),'Registration must collect secondary-channel preferences');
assert(registration.includes('+447700900123')&&registration.toLowerCase().includes('international format'),'Registration must explain the WhatsApp country-code destination format');
assert(adminNotifications.includes('Notification control room')&&adminNotifications.includes('Global event catalogue'),'Global Notifications must remain the operator control centre for shared messaging infrastructure and event routing');
assert(adminNotifications.includes('/admin/profile/notifications'),'Global Notifications must link to each admin profile notification matrix');
assert(adminNotifications.includes('customer_opt_in_allowed'),'Global Notifications must control which customer events may be exposed');
assert(adminLinks.includes('admin_channel_link_tokens')&&adminLinks.includes('admin_communication_preferences'),'Admin Telegram/Discord linking must use each admin identity, not a global destination');
assert(operations.includes('canonical=production||Boolean(requireCanonical)'),'Production external URLs must always use the canonical configured origin');

assert(orders.includes('LEFT JOIN app_users u ON u.id=c.user_id'),'Orders must resolve customer identity through the canonical app-user relation');
assert(orders.includes("COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) customer_email"),'Orders must use real customer/app-user email columns');
assert(!orders.includes('c.login_email')&&!orders.includes('c.login_username'),'Orders must not reference retired/nonexistent customer login columns');
assert(orders.includes("COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name"),'Orders should prefer immutable subscription plan snapshots when available');
assert(referrals.includes("'admin.affiliates.settings','platform_setting','affiliate_program'"),'Affiliate settings audit rows must identify the platform setting entity');
assert(!referrals.includes("'admin.affiliates.settings',NULL,NULL"),'Affiliate settings must never append an audit row with a null entity type');

assert(baseline.includes('telegram_chat_id')&&baseline.includes('discord_user_id')&&baseline.includes('customer_channel_link_tokens'),'Original customer bot identity/linking architecture must remain present');
assert(baseline.includes('admin_notification_preferences')&&baseline.includes('customer_notification_preferences'),'Scoped event routing tables must be created');
assert(/event_scope = ANY \(ARRAY\['admin'::text, 'customer'::text, 'both'::text\]\)/.test(baseline),'Notification catalogue must explicitly distinguish customer/admin audiences');

console.log('customer bot + commerce regression smoke: ok');
