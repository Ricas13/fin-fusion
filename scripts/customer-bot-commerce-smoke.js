'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const nav=require('../src/platform/admin-nav');
const adminShell=require('../src/platform/admin-html-core-base');
const discordRoles=require('../src/integrations/discord-roles');

const plans=read('src/platform/admin-plans-list.js');
const adminPlans=read('src/platform/admin-plans.js');
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
for(const title of ['Payments','Provider mappings','Billing','Transactions','Export data','Payment Risk Policy','Payment History','Migrate paid users'])assert.strictEqual(adminShell.paymentTabsFor({title}),'',`Shared admin shell must not render a payment workflow tab row for ${title}`);
assert.deepStrictEqual(
  nav.childPages('payments').map(page=>page[1]),
  ['Billing','Transactions','Prepaid refunds','Export data','Expenses & Profitability','Provider mappings','Payment risk'],
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
assert(communications.includes('req.query.error')&&communications.includes("links.inspect(state,'discord'")&&communications.includes('belongs to another signed-in account'),'Discord customer callback must handle provider errors and validate the pending one-time state before exchanging the OAuth code');
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
assert(read('src/integrations/customer-channel-links.js').includes('async function inspect'),'Customer channel link tokens must be inspectable before Discord OAuth code exchange');
assert(operations.includes('canonical=production||Boolean(requireCanonical)'),'Production external URLs must always use the canonical configured origin');

assert(adminPlans.includes('discordRoleControl(plan,discordCatalogue)'),'Plan overview must render the shared Discord role selector/fallback control');
assert(adminPlans.includes('Current mapping —')&&adminPlans.includes('Manual role ID fallback'),'Plan role UX must preserve an existing mapping when Discord cannot currently offer it');
assert(adminPlans.includes("throw new Error('Choose a Discord role or enter a valid Discord role ID.')"),'Malformed Discord role IDs must fail visibly instead of silently clearing a plan mapping');
assert(adminNotifications.includes('Plan role assignment')&&adminNotifications.includes('Validate Discord + roles'),'Global Notifications must distinguish Discord role-assignment readiness from basic bot connectivity');
assert(adminNotifications.includes('discordRoles.roleCatalogue({force:true})'),'The explicit Discord validation action must refresh guild role readiness');

const guildId='100000000000000001';
const botId='200000000000000002';
const botRoleId='300000000000000003';
const customerRoleId='400000000000000004';
const managedRoleId='500000000000000005';
const highRoleId='600000000000000006';
const baseRoles=[
  {id:guildId,name:'@everyone',position:0,managed:false,permissions:'0'},
  {id:botRoleId,name:'CAPTAiNFiN',position:10,managed:false,permissions:String(discordRoles.DISCORD_MANAGE_ROLES)},
  {id:customerRoleId,name:'Premium',position:5,managed:false,permissions:'0'},
  {id:managedRoleId,name:'Integration role',position:4,managed:true,permissions:'0'},
  {id:highRoleId,name:'Staff',position:11,managed:false,permissions:'0'}
];
const analysed=discordRoles.analyzeGuildRoles({guildId,bot:{id:botId,username:'CAPTAiNFiN'},member:{roles:[botRoleId]},roles:baseRoles});
assert.strictEqual(analysed.ready,true,'A bot with Manage Roles and a higher role must be ready for plan-role assignment');
assert.deepStrictEqual(analysed.assignableRoles.map(role=>role.id),[customerRoleId],'Only unmanaged roles below the bot hierarchy may be offered as plan roles');
assert.strictEqual(analysed.roles.find(role=>role.id===managedRoleId).reason,'managed_by_discord','Discord-managed roles must never be offered for plan assignment');
assert.strictEqual(analysed.roles.find(role=>role.id===highRoleId).reason,'above_bot_role','Roles at or above the bot hierarchy must never be offered for plan assignment');

const noPermission=discordRoles.analyzeGuildRoles({guildId,bot:{id:botId},member:{roles:[botRoleId]},roles:baseRoles.map(role=>role.id===botRoleId?{...role,permissions:'0'}:role)});
assert.strictEqual(noPermission.ready,false,'Role assignment must not report ready without Manage Roles');
assert.strictEqual(noPermission.reason,'missing_manage_roles','Missing Manage Roles must be diagnosed explicitly');
assert.strictEqual(noPermission.assignableRoles.length,0,'No roles are assignable when the bot lacks Manage Roles');

const administrator=discordRoles.analyzeGuildRoles({guildId,bot:{id:botId},member:{roles:[botRoleId]},roles:baseRoles.map(role=>role.id===botRoleId?{...role,permissions:String(discordRoles.DISCORD_ADMINISTRATOR)}:role)});
assert.strictEqual(administrator.ready,true,'Administrator permission must satisfy Discord role-management readiness');
assert.strictEqual(discordRoles.snowflake('123456789012345678'),'123456789012345678','Valid Discord snowflakes must be retained');
assert.strictEqual(discordRoles.snowflake('not-a-role'),null,'Invalid Discord role identifiers must be rejected');

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
