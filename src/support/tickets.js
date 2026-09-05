'use strict';

const { query, transaction } = require('../db');

const CATEGORIES=new Set(['billing','access','technical','content','account','other']);
const PRIORITIES=new Set(['low','normal','high','urgent']);
const STATUSES=new Set(['open','awaiting_staff','awaiting_customer','resolved','closed']);

function cleanText(value,{min=1,max=10000,label='Text'}={}){
  const text=String(value||'').trim();
  if(text.length<min||text.length>max)throw new Error(`${label} must be between ${min} and ${max} characters.`);
  return text;
}
function category(value){const v=String(value||'other').trim().toLowerCase();if(!CATEGORIES.has(v))throw new Error('Invalid ticket category.');return v;}
function priority(value){const v=String(value||'normal').trim().toLowerCase();if(!PRIORITIES.has(v))throw new Error('Invalid ticket priority.');return v;}
function status(value){const v=String(value||'').trim().toLowerCase();if(!STATUSES.has(v))throw new Error('Invalid ticket status.');return v;}

async function create({customerId,customerUserId,subject,category:categoryValue,message,priority:priorityValue='normal'}){
  const normalizedSubject=cleanText(subject,{min:3,max:180,label:'Subject'}),normalizedMessage=cleanText(message,{min:1,max:10000,label:'Message'}),normalizedCategory=category(categoryValue),normalizedPriority=priority(priorityValue);
  return transaction(async client=>{
    const created=await client.query(`INSERT INTO support_tickets(customer_id,subject,category,priority,status,last_customer_reply_at) VALUES($1,$2,$3,$4,'open',NOW()) RETURNING *`,[customerId,normalizedSubject,normalizedCategory,normalizedPriority]);
    const ticket=created.rows[0];
    const inserted=await client.query(`INSERT INTO support_ticket_messages(ticket_id,author_kind,author_user_id,body) VALUES($1,'customer',$2,$3) RETURNING id,created_at`,[ticket.id,customerUserId||null,normalizedMessage]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'support.ticket.create','support_ticket',$2,$3::jsonb)`,[customerUserId||null,ticket.id,JSON.stringify({ticketNumber:ticket.ticket_number,customerId,category:normalizedCategory})]);
    return {...ticket,initial_message_id:inserted.rows[0].id,initial_message_created_at:inserted.rows[0].created_at};
  });
}

async function listForCustomer(customerId){return (await query(`SELECT * FROM support_tickets WHERE customer_id=$1 ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'awaiting_staff' THEN 0 WHEN 'awaiting_customer' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,updated_at DESC`,[customerId])).rows;}
async function getForCustomer(ticketId,customerId){
  const ticket=(await query(`SELECT * FROM support_tickets WHERE id=$1 AND customer_id=$2`,[ticketId,customerId])).rows[0];
  if(!ticket)return null;
  const messages=(await query(`SELECT * FROM support_ticket_messages WHERE ticket_id=$1 AND internal_note=FALSE ORDER BY created_at,id`,[ticketId])).rows;
  return{ticket,messages};
}
async function replyCustomer({ticketId,customerId,customerUserId,message}){
  const body=cleanText(message,{label:'Message'});
  return transaction(async client=>{
    const locked=(await client.query(`SELECT * FROM support_tickets WHERE id=$1 AND customer_id=$2 FOR UPDATE`,[ticketId,customerId])).rows[0];
    if(!locked)throw new Error('Ticket not found.');
    if(locked.status==='closed')throw new Error('This ticket is closed. Start a new ticket if you still need help.');
    const inserted=await client.query(`INSERT INTO support_ticket_messages(ticket_id,author_kind,author_user_id,body) VALUES($1,'customer',$2,$3) RETURNING id,created_at`,[ticketId,customerUserId||null,body]);
    const updated=(await client.query(`UPDATE support_tickets SET status='awaiting_staff',last_customer_reply_at=NOW(),resolved_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[ticketId])).rows[0];
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'support.ticket.customer_reply','support_ticket',$2,'{}'::jsonb)`,[customerUserId||null,ticketId]);
    return{ticket:updated,messageId:inserted.rows[0].id,createdAt:inserted.rows[0].created_at};
  });
}

async function listForAdmin(filter='active',q=''){
  const where=filter==='closed'?`t.status='closed'`:filter==='resolved'?`t.status='resolved'`:filter==='all'?'':`t.status IN ('open','awaiting_staff','awaiting_customer')`;
  const search=cleanText(q,{min:0,max:200,label:'Search'});
  const conditions=[where].filter(Boolean),params=[];
  if(search){params.push(`%${search}%`);conditions.push(`(t.ticket_number::text ILIKE $${params.length} OR t.subject ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`);}
  const clause=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  return (await query(`SELECT t.*,c.display_name,
    COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(u.email),'')) customer_email,
    u.username customer_username,
    au.username assigned_admin_username
    FROM support_tickets t
    JOIN customers c ON c.id=t.customer_id
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN app_users au ON au.id=t.assigned_admin_user_id
    ${clause}
    ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'awaiting_staff' THEN 0 WHEN 'awaiting_customer' THEN 1 ELSE 2 END,t.updated_at DESC LIMIT 500`,params)).rows;
}
async function getForAdmin(ticketId){
  const ticket=(await query(`SELECT t.*,c.display_name,
    COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(u.email),'')) customer_email,
    u.username customer_username,
    au.username assigned_admin_username
    FROM support_tickets t
    JOIN customers c ON c.id=t.customer_id
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN app_users au ON au.id=t.assigned_admin_user_id
    WHERE t.id=$1`,[ticketId])).rows[0];
  if(!ticket)return null;
  const messages=(await query(`SELECT * FROM support_ticket_messages WHERE ticket_id=$1 ORDER BY created_at,id`,[ticketId])).rows;
  return{ticket,messages};
}
async function replyAdmin({ticketId,adminUserId,message,internalNote=false}){
  const body=cleanText(message,{label:internalNote?'Internal note':'Reply'});
  return transaction(async client=>{
    const ticket=(await client.query(`SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE`,[ticketId])).rows[0];
    if(!ticket)throw new Error('Ticket not found.');
    const inserted=await client.query(`INSERT INTO support_ticket_messages(ticket_id,author_kind,author_user_id,body,internal_note) VALUES($1,'admin',$2,$3,$4) RETURNING id,created_at`,[ticketId,adminUserId||null,body,Boolean(internalNote)]);
    if(!internalNote)await client.query(`UPDATE support_tickets SET status='awaiting_customer',last_staff_reply_at=NOW(),updated_at=NOW() WHERE id=$1`,[ticketId]);
    else await client.query(`UPDATE support_tickets SET updated_at=NOW() WHERE id=$1`,[ticketId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'support_ticket',$3,$4::jsonb)`,[adminUserId,internalNote?'support.ticket.internal_note':'support.ticket.staff_reply',ticketId,JSON.stringify({internalNote:Boolean(internalNote)})]);
    return{messageId:inserted.rows[0].id,createdAt:inserted.rows[0].created_at,internalNote:Boolean(internalNote)};
  });
}
async function updateAdmin({ticketId,adminUserId,status:statusValue,priority:priorityValue,assignment='keep'}){
  const nextStatus=status(statusValue),nextPriority=priority(priorityValue);
  await transaction(async client=>{
    const existing=(await client.query(`SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE`,[ticketId])).rows[0];
    if(!existing)throw new Error('Ticket not found.');
    const nextAssigned=assignment==='me'?adminUserId:assignment==='none'?null:existing.assigned_admin_user_id;
    await client.query(`UPDATE support_tickets SET status=$2,priority=$3,assigned_admin_user_id=$4,resolved_at=CASE WHEN $2='resolved' THEN COALESCE(resolved_at,NOW()) ELSE NULL END,closed_at=CASE WHEN $2='closed' THEN COALESCE(closed_at,NOW()) ELSE NULL END,updated_at=NOW() WHERE id=$1`,[ticketId,nextStatus,nextPriority,nextAssigned]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'support.ticket.update','support_ticket',$2,$3::jsonb)`,[adminUserId,ticketId,JSON.stringify({status:nextStatus,priority:nextPriority,assignedAdminUserId:nextAssigned})]);
  });
}
async function staffQueueSummary(since=null){
  const row=(await query(`SELECT COUNT(*)::int n,MAX(COALESCE(last_customer_reply_at,created_at)) updated FROM support_tickets WHERE status IN ('open','awaiting_staff') AND ($1::timestamptz IS NULL OR COALESCE(last_customer_reply_at,created_at)>$1::timestamptz)`,[since])).rows[0];
  return{count:Number(row?.n||0),updatedAt:row?.updated||null};
}

module.exports={CATEGORIES,PRIORITIES,STATUSES,create,listForCustomer,getForCustomer,replyCustomer,listForAdmin,getForAdmin,replyAdmin,updateAdmin,staffQueueSummary,cleanText,category,priority,status};
