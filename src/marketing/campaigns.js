'use strict';
const {query}=require('../db');
const customerFilters=require('../platform/customer-filters');
const segments=require('./segments');
const emailOutbox=require('../integrations/email-outbox');
const notificationOutbox=require('../integrations/notification-outbox');

function clean(value,min,max,label){const text=String(value||'').trim();if(text.length<min||text.length>max)throw new Error(`${label} must be between ${min} and ${max} characters.`);return text;}

async function validateDiscount(discountCodeId){
  if(!discountCodeId)return null;
  const row=(await query(`SELECT id FROM discount_codes WHERE id=$1 AND active=TRUE AND (expires_at IS NULL OR expires_at>NOW())`,[discountCodeId])).rows[0];
  if(!row)throw new Error('Choose an active, unexpired discount code.');
  return row.id;
}

async function eligibleCustomers(audienceFilters){
  const ids=await customerFilters.matchingCustomerIds(audienceFilters,null);
  if(!ids.length)return[];
  const rows=(await query(`
    SELECT c.id customer_id,
           COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(au.email),'')) email,
           COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),'Customer') display_name
    FROM customers c
    LEFT JOIN app_users au ON au.id=c.user_id
    WHERE c.id=ANY($1::uuid[]) AND c.marketing_opt_in=TRUE
  `,[ids])).rows;
  return rows;
}
async function preview(audienceFilters){
  const ids=await customerFilters.matchingCustomerIds(audienceFilters,null);
  if(!ids.length)return{count:0};
  const row=(await query(`SELECT COUNT(*)::int count FROM customers WHERE id=ANY($1::uuid[]) AND marketing_opt_in=TRUE`,[ids])).rows[0];
  return{count:Number(row?.count||0)};
}

async function create({name,subject,bodyText,discountCodeId,audienceFilters,segmentId=null,adminUserId}){
  const discountId=await validateDiscount(discountCodeId);
  let savedSegment=null;
  let filters;
  if(segmentId){
    savedSegment=await segments.get(segmentId);
    if(!savedSegment)throw new Error('The selected saved segment no longer exists.');
    filters=segments.normalizeFilters(savedSegment.audience_filters||{});
  }else{
    filters=segments.normalizeFilters(audienceFilters||{});
  }
  await segments.validatePlan(filters);
  const row=(await query(`INSERT INTO marketing_campaigns(name,subject,body_text,discount_code_id,audience_filters,segment_id,created_by_user_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
    [clean(name,3,160,'Name'),clean(subject,3,300,'Subject'),clean(bodyText,1,100000,'Body'),discountId,JSON.stringify(filters),savedSegment?.id||null,adminUserId])).rows[0];
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.create','marketing_campaign',$2,$3::jsonb)`,[adminUserId,row.id,JSON.stringify({name:row.name,segmentId:savedSegment?.id||null,audienceFilters:filters})]);
  return row;
}
async function list(){return(await query(`SELECT mc.*,ms.name segment_name FROM marketing_campaigns mc LEFT JOIN marketing_segments ms ON ms.id=mc.segment_id ORDER BY mc.created_at DESC`)).rows;}
async function get(id){
  const campaign=(await query(`SELECT mc.*,ms.name segment_name FROM marketing_campaigns mc LEFT JOIN marketing_segments ms ON ms.id=mc.segment_id WHERE mc.id=$1`,[id])).rows[0];
  if(!campaign)return null;
  const recipients=(await query(`SELECT * FROM marketing_campaign_recipients WHERE campaign_id=$1`,[id])).rows;
  const deliveries=(await query(`SELECT * FROM marketing_campaign_deliveries WHERE campaign_id=$1`,[id])).rows;
  const discountCode=campaign.discount_code_id?(await query(`SELECT id,code,description FROM discount_codes WHERE id=$1`,[campaign.discount_code_id])).rows[0]:null;
  return{campaign,recipients,deliveries,discountCode};
}

async function snapshotRecipients(campaign){
  const rows=await eligibleCustomers(campaign.audience_filters||{});
  for(const row of rows){
    await query(`INSERT INTO marketing_campaign_recipients(campaign_id,customer_id,email_snapshot,display_name_snapshot) VALUES($1,$2,$3,$4) ON CONFLICT(campaign_id,customer_id) DO NOTHING`,
      [campaign.id,row.customer_id,row.email,row.display_name]);
  }
  await query(`UPDATE marketing_campaigns SET recipient_count=(SELECT COUNT(*) FROM marketing_campaign_recipients WHERE campaign_id=$1),updated_at=NOW() WHERE id=$1`,[campaign.id]);
}

function renderMessage(campaign,recipient,discountCode){
  const codeText=discountCode?` Use code ${discountCode.code}.`:'';
  return{text:`${campaign.body_text}${codeText}`,html:null};
}

async function currentConsent(customerIds){
  if(!customerIds.length)return new Map();
  const rows=(await query(`
    SELECT c.id customer_id,c.marketing_opt_in,
           cp.telegram_opt_in,cp.telegram_chat_id,cp.discord_opt_in,cp.discord_user_id,cp.whatsapp_opt_in,cp.phone_e164
    FROM customers c LEFT JOIN customer_communication_preferences cp ON cp.customer_id=c.id
    WHERE c.id=ANY($1::uuid[])
  `,[customerIds])).rows;
  return new Map(rows.map(r=>[String(r.customer_id),r]));
}

async function queue({campaignId,adminUserId=null}){
  let data=await get(campaignId);
  if(!data)throw new Error('Campaign not found.');
  if(!['draft','scheduled','queued'].includes(data.campaign.status))throw new Error('Only draft, scheduled or partially queued campaigns can be queued.');
  await snapshotRecipients(data.campaign);
  data=await get(campaignId);
  if(!data.recipients.length)throw new Error('No eligible opted-in recipients are available for this campaign.');
  const consent=await currentConsent(data.recipients.map(r=>r.customer_id));
  let queuedCount=0,suppressedCount=0;
  for(const recipient of data.recipients){
    const now=consent.get(String(recipient.customer_id));
    if(!now?.marketing_opt_in){
      suppressedCount+=1;
      await query(`UPDATE marketing_campaign_recipients SET status='suppressed',suppression_reason='opted_out_before_send',updated_at=NOW() WHERE campaign_id=$1 AND customer_id=$2`,[campaignId,recipient.customer_id]);
      continue;
    }
    const channels=[];
    if(recipient.email_snapshot)channels.push('email');
    if(now.discord_opt_in&&now.discord_user_id)channels.push('discord');
    if(now.telegram_opt_in&&now.telegram_chat_id)channels.push('telegram');
    if(now.whatsapp_opt_in&&now.phone_e164)channels.push('whatsapp');
    if(!channels.length){
      suppressedCount+=1;
      await query(`UPDATE marketing_campaign_recipients SET status='suppressed',suppression_reason='no_channel_available',updated_at=NOW() WHERE campaign_id=$1 AND customer_id=$2`,[campaignId,recipient.customer_id]);
      continue;
    }
    const message=renderMessage(data.campaign,recipient,data.discountCode);
    for(const channel of channels){
      const dedupeKey=`marketing:${campaignId}:${recipient.customer_id}:${channel}`;
      let outboxId=null,status='queued';
      try{
        if(channel==='email'){const item=await emailOutbox.enqueue({type:'marketing_campaign',to:recipient.email_snapshot,subject:data.campaign.subject,text:message.text,html:message.html||'',dedupeKey});outboxId=item.id;}
        else if(channel==='discord'){const item=await notificationOutbox.enqueueDiscord({eventType:'marketing_campaign',text:message.text,destination:now.discord_user_id,dedupeKey});outboxId=item.id;status=item.queued?'queued':'suppressed';}
        else if(channel==='telegram'){const item=await notificationOutbox.enqueueTelegram({eventType:'marketing_campaign',text:message.text,destination:now.telegram_chat_id,dedupeKey});outboxId=item.id;status=item.queued?'queued':'suppressed';}
        else if(channel==='whatsapp'){const item=await notificationOutbox.enqueueWhatsapp({eventType:'marketing_campaign',text:message.text,destination:now.phone_e164,dedupeKey});outboxId=item.id;status=item.queued?'queued':'suppressed';}
      }catch(error){status='failed';}
      await query(`INSERT INTO marketing_campaign_deliveries(campaign_id,customer_id,channel,status,outbox_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(campaign_id,customer_id,channel) DO UPDATE SET status=EXCLUDED.status,outbox_id=EXCLUDED.outbox_id,updated_at=NOW()`,
        [campaignId,recipient.customer_id,channel,status,outboxId]);
    }
    queuedCount+=1;
    await query(`UPDATE marketing_campaign_recipients SET status='queued',updated_at=NOW() WHERE campaign_id=$1 AND customer_id=$2`,[campaignId,recipient.customer_id]);
  }
  await query(`UPDATE marketing_campaigns SET status='queued',queued_count=(SELECT COUNT(*) FROM marketing_campaign_recipients WHERE campaign_id=$1 AND status='queued'),queued_at=COALESCE(queued_at,NOW()),schedule_next_attempt_at=NULL,schedule_last_error=NULL,updated_at=NOW() WHERE id=$1`,[campaignId]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.queue','marketing_campaign',$2,$3::jsonb)`,[adminUserId,campaignId,JSON.stringify({queuedNow:queuedCount,suppressedNow:suppressedCount})]);
  return{queued:queuedCount,suppressed:suppressedCount};
}

async function schedule(campaignId,scheduledFor,adminUserId=null){
  await query(`UPDATE marketing_campaigns SET status='scheduled',scheduled_for=$2,schedule_next_attempt_at=$2,updated_at=NOW() WHERE id=$1 AND status='draft'`,[campaignId,scheduledFor]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.schedule','marketing_campaign',$2,$3::jsonb)`,[adminUserId,campaignId,JSON.stringify({scheduledFor})]);
}
async function unschedule(campaignId,adminUserId=null){
  await query(`UPDATE marketing_campaigns SET status='draft',scheduled_for=NULL,schedule_next_attempt_at=NULL,updated_at=NOW() WHERE id=$1 AND status='scheduled'`,[campaignId]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'marketing.campaign.unschedule','marketing_campaign',$2,'{}'::jsonb)`,[adminUserId,campaignId]);
}
async function due(limit=20){return(await query(`SELECT id FROM marketing_campaigns WHERE status='scheduled' AND COALESCE(schedule_next_attempt_at,scheduled_for)<=NOW() ORDER BY scheduled_for LIMIT $1`,[limit])).rows;}
async function runDue({limit=20}={}){
  const rows=await due(limit);let processed=0,failed=0;
  for(const row of rows){
    try{await queue({campaignId:row.id});processed+=1;}
    catch(error){failed+=1;await query(`UPDATE marketing_campaigns SET schedule_attempts=schedule_attempts+1,schedule_last_error=$2,schedule_next_attempt_at=NOW()+INTERVAL '30 minutes',updated_at=NOW() WHERE id=$1`,[row.id,String(error.message).slice(0,1000)]);}
  }
  return{processed,failed};
}
module.exports={eligibleCustomers,preview,create,list,get,queue,schedule,unschedule,due,runDue,validateDiscount};
