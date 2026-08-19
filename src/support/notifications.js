'use strict';

const outbox=require('../integrations/email-outbox');

function esc(value){return String(value||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
async function queueStaffReply({ticket,email,messageId,ticketUrl,siteName='CAPTAiNFiN'}){
  const recipient=String(email||'').trim();
  if(!recipient)return null;
  const subject=`${siteName} support replied to ticket #${ticket.ticket_number}`;
  const text=`There is a new support reply on ticket #${ticket.ticket_number}: ${ticket.subject}\n\nView and reply: ${ticketUrl}\n\nThis is a service message about a support ticket you opened.`;
  const html=`<p>There is a new support reply on <strong>ticket #${esc(ticket.ticket_number)}</strong>: ${esc(ticket.subject)}</p><p><a href="${esc(ticketUrl)}">View and reply to your ticket</a></p><p><small>This is a service message about a support ticket you opened.</small></p>`;
  return outbox.enqueue({type:'support_ticket_reply',to:recipient,subject,text,html,dedupeKey:`support-ticket-reply:${messageId}`});
}
module.exports={queueStaffReply};
