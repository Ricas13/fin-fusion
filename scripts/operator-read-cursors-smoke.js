'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const migration=read('db/migrations/014_admin_operator_read_cursors.sql');
const cursors=read('src/platform/operator-read-cursors.js');
const operator=read('src/platform/admin-operator-state.js');
const tickets=read('src/support/tickets.js');
const client=read('public/js/operator-business-indicators.js');

assert(migration.includes('CREATE TABLE admin_operator_read_cursors'),'operator cursor migration missing');
assert(migration.includes("area IN ('customers','orders','tickets')"),'operator cursor areas must be constrained');
assert(migration.includes('PRIMARY KEY (admin_user_id, area)'),'operator cursor must be per-admin and per-area');
assert(cursors.includes('GREATEST(admin_operator_read_cursors.seen_at,EXCLUDED.seen_at)'),'read cursor must move forward only');
assert(cursors.includes("MAX(COALESCE(last_customer_reply_at,created_at))"),'ticket read watermark must use latest customer activity');
assert(operator.includes('snapshot(res.locals.operatorActorUserId)'),'unread snapshot must be administrator-specific');
assert(operator.includes("router.post('/admin/api/operator-state/read'"),'read acknowledgement endpoint missing');
assert(operator.includes('csrf.verify(req)'),'read acknowledgement must require CSRF');
assert(operator.includes('csrfToken:csrf.token(req)'),'authenticated unread response must provide same-origin CSRF token');
assert(operator.includes('seen.customers')&&operator.includes('seen.orders')&&operator.includes('seen.tickets'),'business counts must use stored cursors');
assert(tickets.includes('staffQueueSummary(since=null)'),'ticket unread summary must accept a cursor');
assert(client.includes("'X-CSRF-Token':data.csrfToken"),'browser read acknowledgement must send CSRF token');
assert(client.includes("normalizedPath===href"),'only the exact business inbox page may mark its area read');
assert(!client.includes('localStorage'),'business unread state must not depend on local browser storage');

console.log('operator read cursors smoke: ok');
