'use strict';

const notifications=require('../integrations/notification-dispatch');

function appendUrl(text,url,label){return url?`${text}\n\n${label}: ${url}`:text;}
function publicContent(value,{internalNote=false}={}){if(internalNote)return'';return String(value||'').trim().replace(/\s+/g,' ').slice(0,900);}

async function queueNeedsStaff({ticket,messageId=null,kind='created',ticketUrl=null,content='',internalNote=false}){
  const isReply=kind==='reply';
  const subject=isReply
    ?`Customer replied to support ticket #${ticket.ticket_number}`
    :`New support ticket #${ticket.ticket_number}`;
  const safeContent=publicContent(content,{internalNote});
  let text=`${ticket.subject}\nCategory: ${ticket.category}\nPriority: ${ticket.priority}`;
  if(safeContent)text+=`\nContent: ${safeContent}`;
  text=appendUrl(text,ticketUrl,'Open ticket');
  return notifications.dispatch({
    eventType:'support.ticket.needs_staff',
    customerId:ticket.customer_id,
    subject,
    text,
    templatePayload:{
      ticketId:ticket.id,
      ticketNumber:ticket.ticket_number,
      ticketTitle:ticket.subject,
      ticketContent:safeContent,
      ticketEventKind:isReply?'reply':'created',
      category:ticket.category,
      priority:ticket.priority,
      status:ticket.status,
      ticketUrl:ticketUrl||''
    },
    dedupeKey:`support-ticket-needs-staff:${isReply?'reply':'created'}:${messageId||ticket.id}`
  });
}

async function queueStaffReply({ticket,email,messageId,ticketUrl,siteName='CAPTAiNFiN'}){
  const recipient=String(email||'').trim();
  if(!recipient)return null;
  const subject=`${siteName} support replied to ticket #${ticket.ticket_number}`;
  let text=`There is a new support reply on ticket #${ticket.ticket_number}: ${ticket.subject}`;
  text=appendUrl(text,ticketUrl,'View and reply');
  text+='\n\nThis is a service message about a support ticket you opened.';
  return notifications.dispatch({
    eventType:'support.ticket.staff_reply',
    customerId:ticket.customer_id,
    to:recipient,
    subject,
    text,
    dedupeKey:`support-ticket-staff-reply:${messageId}`,
    forceEmail:true
  });
}

function anyQueued(result){return Boolean(result&&(result.email||result.telegram||result.discord||result.whatsapp));}

module.exports={queueNeedsStaff,queueStaffReply,anyQueued,publicContent};
