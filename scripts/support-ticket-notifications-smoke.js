'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

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
assert(helper.includes('customerId:ticket.customer_id'),'customer support update must preserve customer identity for optional linked channels');
assert(helper.includes('messageId||ticket.id')&&helper.includes('support-ticket-staff-reply:${messageId}'),'support notification dedupe must be message/ticket specific');
assert(dispatcher.includes('admin_notification_preferences')&&dispatcher.includes('customer_notification_preferences'),'canonical dispatcher must own per-admin/per-customer routing');
assert(tickets.includes('RETURNING id,created_at'),'support message writes must expose stable notification dedupe identity');
assert(customer.includes('await notifyStaff(req'),'customer ticket creation/reply must emit the admin event after the ticket transaction');
assert(customer.includes('Support staff notification could not be queued'),'admin notification failure must be best effort');
assert(admin.includes('Support reply notification could not be queued'),'customer notification failure must be best effort');
assert(admin.includes('supportNotifications.anyQueued(notification)'),'admin response must describe multi-channel queue outcome');
assert(admin.includes('customerTicketUrl')&&customer.includes('adminTicketUrl'),'support notification links must be optional helpers rather than transaction prerequisites');

console.log('support ticket notifications smoke: ok');
