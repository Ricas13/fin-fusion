'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const baseline=read('db/migrations/000_database_baseline.sql');
const cursors=read('src/platform/operator-read-cursors.js');
const operator=read('src/platform/admin-operator-state.js');
const tickets=read('src/support/tickets.js');
const client=read('public/js/operator-business-indicators.js');
const experience=read('public/js/operator-experience.js');

assert(baseline.includes('CREATE TABLE public.admin_nav_read_state'),'canonical admin nav read-state table missing from baseline');
assert(baseline.includes('last_seen_at timestamp with time zone'),'canonical admin nav read-state timestamp missing');
assert(cursors.includes('admin_nav_read_state'),'operator unread state must reuse canonical admin navigation read state');
assert(!cursors.includes('admin_operator_read_cursors'),'operator unread state must not create a second read-state table');
assert(cursors.includes("const NAV_PREFIX = 'operator.business.'"),'operator cursors must use a namespaced nav key');
assert(cursors.includes('GREATEST(admin_nav_read_state.last_seen_at,EXCLUDED.last_seen_at)'),'read cursor must move forward only');
assert(cursors.includes("MAX(COALESCE(last_customer_reply_at,created_at))"),'ticket read watermark must use latest customer activity');
assert(operator.includes('snapshot(res.locals.operatorActorUserId)'),'unread snapshot must be administrator-specific');
assert(operator.includes("router.post('/admin/api/operator-state/read'"),'read acknowledgement endpoint missing');
assert(operator.includes('csrf.verify(req)'),'read acknowledgement must require CSRF');
assert(operator.includes('csrfToken:csrf.token(req)'),'authenticated unread response must provide same-origin CSRF token');
assert(operator.includes('seen.customers')&&operator.includes('seen.orders')&&operator.includes('seen.tickets'),'business counts must use stored cursors');
assert(tickets.includes('staffQueueSummary(since=null)'),'ticket unread summary must accept a cursor');
assert(client.includes("'X-CSRF-Token':data.csrfToken"),'browser read acknowledgement must send CSRF token');
assert(client.includes('businessAreaForPath(normalizedPath)'),'browser must resolve the active business workspace before acknowledging unread state');
assert(client.includes("path==='/admin/users'||path==='/admin/users/dashboard'"),'customer unread state must clear from both the customer list and its Overview landing page');
assert(client.includes("path==='/admin/orders'")&&client.includes("path==='/admin/tickets'"),'orders and tickets must still clear only from their own inbox pages');
assert(!/\blocalStorage\s*\.(?:getItem|setItem|removeItem|clear)\s*\(/.test(client),'business unread state must not depend on local browser storage');
assert(!/\blocalStorage\s*\.(?:getItem|setItem|removeItem|clear)\s*\(/.test(experience),'legacy operator experience must not maintain a second local unread cursor');
assert(!experience.includes("fetch('/admin/api/operator-state/unread'"),'legacy operator experience must not independently fetch unread counts');
assert(experience.includes('operator-business-indicators.js'),'legacy helper must document the canonical unread owner to prevent drift');

console.log('operator read cursors smoke: ok');