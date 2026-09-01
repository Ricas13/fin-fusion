'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const adminTemplates=require('../src/integrations/admin-notification-template');
const discordNotification=require('../src/integrations/discord-notification');
const supportNotifications=require('../src/support/notifications');

const migration=read('db/migrations/014_support_ticket_notification_events.sql');
const helper=read('src/support/notifications.js');
const tickets=read('src/support/tickets.js');
const customer=read('src/platform/customer-support.js');
const admin=read('src/platform/admin-support-tickets.js');
const dispatcher=read('src/integrations/notification-dispatch.js');

for(const event of ['support.ticket.needs_staff','support.ticket.staff_reply'])assert(migration.includes(event),`missing ${event} catalogue event`);
assert(migration.includes("'support.ticket.needs_staff', TRUE, TRUE, TRUE, TRUE, 'admin', FALSE"),'staff-needed event must remain admin scoped');
assert(migration.includes("'support.ticket.staff_reply', TRUE, TRUE, TRUE, TRUE, 'customer', TRUE"),'staff reply event must be customer scoped and opt-in eligible');
assert(helper.includes("require('../integrations/notification-dispatch')"),'support notifications must use canonical dispatcher');
assert(!helper.includes("require('../integrations/email-outbox')"),'support notifications must not own a direct email-outbox path');
assert(helper.includes("eventType:'support.ticket.needs_staff'"),'staff-needed notification dispatch missing');
assert(helper.includes("eventType:'support.ticket.staff_reply'"),'customer staff-reply notification dispatch missing');
assert(helper.includes('forceEmail:true'),'support staff reply must keep transactional email mandatory');
assert(helper.includes('customerId:ticket.customer_id'),'support events must preserve customer identity for canonical routing and facts');
assert(helper.includes('ticketContent:safeContent'),'staff-needed notifications must carry only sanitized public ticket content');
assert(helper.includes('internalNote')&&helper.includes("if(internalNote)return''"),'internal staff notes must be explicitly excluded from notification content');
assert(helper.includes('messageId||ticket.id')&&helper.includes('support-ticket-staff-reply:${messageId}'),'support notification dedupe must be message/ticket specific');
assert(dispatcher.includes('admin_notification_preferences')&&dispatcher.includes('customer_notification_preferences'),'canonical dispatcher must own per-admin/per-customer routing');
assert(dispatcher.includes('renderAdminNotification'),'admin channels must share the canonical admin renderer');
assert(tickets.includes('RETURNING id,created_at'),'support message writes must expose stable notification dedupe identity');
assert(customer.includes('await notifyStaff(req'),'customer ticket creation/reply must emit the admin event after the ticket transaction');
assert(customer.includes('content:req.body.message'),'customer support notifications must pass the public customer message');
assert(customer.includes('Support staff notification could not be queued'),'admin notification failure must be best effort');
assert(admin.includes('Support reply notification could not be queued'),'customer notification failure must be best effort');
assert(admin.includes('supportNotifications.anyQueued(notification)'),'admin response must describe multi-channel queue outcome');
assert(admin.includes('customerTicketUrl')&&customer.includes('adminTicketUrl'),'support notification links must be optional helpers rather than transaction prerequisites');

const payment=adminTemplates.renderAdminNotification({
  eventType:'payment.received',
  payload:{customerName:'Maria',planName:'Premium',amount:9.99,currency:'GBP',provider:'stripe'}
});
assert(payment.email.title==='Payment received','payment admin title must be canonical');
assert(payment.email.facts.slice(0,3).map(row=>row.label).join('|')==='User|Plan|Amount','admin facts must start with User, Plan, Amount');
assert(payment.email.facts.find(row=>row.label==='Amount')?.value.includes('9.99'),'payment amount must remain visible');

const server=adminTemplates.renderAdminNotification({
  eventType:'server.offline',
  subject:'Jellyfin server offline: UK-4K-1',
  text:'UK-4K-1 has crossed the health threshold into offline state.'
});
assert(server.email.title==='Server offline','server-offline title must be canonical');
assert(server.email.facts.some(row=>row.label==='Server'&&row.value==='UK-4K-1'),'server-offline notification must identify the server');
assert(server.email.facts.some(row=>row.label==='Status'&&row.value==='Offline'),'server-offline notification must state Offline');

const ticket=adminTemplates.renderAdminNotification({
  eventType:'support.ticket.needs_staff',
  payload:{customerName:'Maria',ticketNumber:42,ticketTitle:'Playback problem',ticketContent:'Video stops after ten seconds.',category:'technical',priority:'high',ticketUrl:'https://example.test/admin/tickets/42'}
});
const ticketLabels=ticket.email.facts.map(row=>row.label);
assert(ticket.email.title==='New support ticket','support admin title must be canonical');
for(const label of ['User','Ticket title','Content','Priority','Category'])assert(ticketLabels.includes(label),`support notification missing ${label}`);
assert(ticket.email.facts.find(row=>row.label==='Content')?.value==='Video stops after ten seconds.','support content must remain useful');
assert(ticket.email.actionUrl.endsWith('/admin/tickets/42'),'support action must open the ticket, not just the customer');

const card=discordNotification.render({eventType:'support.ticket.needs_staff',payload:ticket.email.payload,emailSpec:ticket.email,audience:'admin'});
const fields=card.embeds?.[0]?.fields||[];
assert(card.embeds?.[0]?.title==='💬 New support ticket','Discord must use the canonical support title');
assert(fields.some(row=>row.name==='Ticket title'&&row.value==='Playback problem'),'Discord must render the ticket title');
assert(fields.some(row=>row.name==='Content'&&row.value==='Video stops after ten seconds.'),'Discord must render public ticket content');

assert(supportNotifications.publicContent('PRIVATE STAFF NOTE',{internalNote:true})==='','internal notes must never enter notification content');
const sanitized=supportNotifications.publicContent('  public\n customer   reply  ');
assert(sanitized==='public customer reply','public support content must be normalized without being lost');

const sparse=adminTemplates.renderAdminNotification({eventType:'customer.claimed',payload:{customerName:'Maria'}});
assert(sparse.email.facts.length===1&&sparse.email.facts[0].label==='User','missing optional facts must be omitted, not rendered as placeholders');
const unknown=adminTemplates.renderAdminNotification({eventType:'future.admin.event',subject:'Producer fallback',text:'Fallback detail',payload:{customerName:'Maria'}});
assert(unknown.email.title==='Producer fallback'&&unknown.email.text==='Fallback detail','unknown admin events must retain producer fallback wording');

console.log('support ticket notifications smoke: ok');
