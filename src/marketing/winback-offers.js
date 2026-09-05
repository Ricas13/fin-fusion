'use strict';

const {query,transaction}=require('../db');
const emailOutbox=require('../integrations/email-outbox');
const {renderProfessionalEmail}=require('../integrations/email-template');
const runtimeSettings=require('../platform/runtime-settings');
const operations=require('../platform/operations-settings');
const serviceScope=require('../entitlements/service-scope');

const DEFAULT_DELAY_DAYS=3;
const DEFAULT_OFFER_DAYS=7;
const DEFAULT_COOLDOWN_DAYS=90;
const PROCESSING_STALE_MINUTES=15;
const RETRY_MINUTES=30;

function boundedDays(name,fallback,min,max){const value=Number(process.env[name]);return Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;}
function config(){return{delayDays:boundedDays('WINBACK_DELAY_DAYS',DEFAULT_DELAY_DAYS,1,30),offerDays:boundedDays('WINBACK_OFFER_DAYS',DEFAULT_OFFER_DAYS,1,30),cooldownDays:boundedDays('WINBACK_COOLDOWN_DAYS',DEFAULT_COOLDOWN_DAYS,30,365)};}
function exposed(message,code){const error=new Error(message);error.code=code;error.expose=true;return error;}
function planMatchesKind(kind,plan){const interval=String(plan?.billing_interval||'').toLowerCase();if(kind==='monthly_25')return interval==='month';if(kind==='longterm_10')return interval==='6_months'||interval==='year';return false;}
function scopesOverlap(left,right){return serviceScope.overlaps({service_type:left},{service_type:right});}

async function discoverCandidates({limit=200}={}){
  const cfg=config(),safeLimit=Math.max(1,Math.min(1000,Number(limit)||200));
  const candidates=(await query(`
    SELECT s.id subscription_id,s.customer_id,
           COALESCE(s.service_type_snapshot,p.service_type,'jellyfin') service_type,
           s.updated_at terminal_at,
           (SELECT a.action FROM audit_log a
              WHERE a.entity_type='subscription' AND a.entity_id=s.id::text
                AND a.action IN ('billing.renewal.stop','billing.renewal.resume')
              ORDER BY a.created_at DESC,a.id DESC LIMIT 1) renewal_decision,
           EXISTS(
             SELECT 1 FROM payment_incidents pi
              WHERE pi.customer_id=s.customer_id
                AND pi.incident_type='failed_renewal'
                AND ((s.provider_subscription_id IS NOT NULL AND pi.provider_subscription_id=s.provider_subscription_id)
                     OR (s.provider_subscription_id IS NULL AND pi.provider_subscription_id IS NULL AND pi.provider=s.source))
           ) had_failed_renewal
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      CROSS JOIN winback_runtime wr
     WHERE s.billing_mode='subscription'
       AND s.source IN ('stripe','paypal')
       AND s.status IN ('cancelled','expired')
       AND s.current_period_end<=NOW()
       AND s.updated_at>=wr.activated_at
       AND COALESCE(s.billing_interval_snapshot,p.billing_interval)<>'trial'
       AND COALESCE(
             CASE WHEN COALESCE(s.commercial_snapshot->>'grossDiscountedMinor','') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'grossDiscountedMinor')::integer END,
             CASE WHEN COALESCE(s.commercial_snapshot->>'discountedMinor','') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'discountedMinor')::integer END,
             s.price_minor_snapshot,p.price_minor,0
           )>0
       AND NOT EXISTS(SELECT 1 FROM winback_offers w WHERE w.trigger_subscription_id=s.id)
       AND NOT EXISTS(
         SELECT 1 FROM audit_log terminal_audit
          WHERE terminal_audit.entity_type='subscription'
            AND terminal_audit.entity_id=s.id::text
            AND terminal_audit.action IN ('billing.subscription.terminate_local','billing.subscription.terminate_for_refund')
       )
     ORDER BY s.updated_at,s.id
     LIMIT $1
  `,[safeLimit])).rows;
  let discovered=0;
  for(const row of candidates){
    const reason=row.renewal_decision==='billing.renewal.stop'?'voluntary_cancel':(row.had_failed_renewal?'payment_failed':null);
    if(!reason)continue;
    const inserted=await query(`
      INSERT INTO winback_offers(customer_id,trigger_subscription_id,trigger_reason,service_type,terminal_at,eligible_at,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$5+make_interval(days=>$6),$5+make_interval(days=>$6))
      ON CONFLICT(trigger_subscription_id) DO NOTHING RETURNING id
    `,[row.customer_id,row.subscription_id,reason,row.service_type,row.terminal_at,cfg.delayDays]);
    discovered+=inserted.rowCount;
  }
  return discovered;
}

async function activePaidRows(db,customerId){
  return(await db.query(`
    SELECT COALESCE(s.service_type_snapshot,p.service_type,'jellyfin') service_type
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.starts_at<=NOW()
       AND s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW()
       AND COALESCE(s.billing_interval_snapshot,p.billing_interval)<>'trial'
       AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0
  `,[customerId])).rows;
}
async function hasActivePaidOverlap(db,customerId,serviceType){const rows=await activePaidRows(db,customerId);return rows.some(row=>scopesOverlap(row.service_type,serviceType));}

async function claimOne(){
  return transaction(async client=>{
    const cfg=config();
    const found=await client.query(`
      SELECT id FROM winback_offers
       WHERE ((status='pending' AND eligible_at<=NOW() AND next_attempt_at<=NOW())
          OR (status='processing' AND processing_started_at<=NOW()-make_interval(mins=>$1)))
       ORDER BY eligible_at,created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
    `,[PROCESSING_STALE_MINUTES]);
    if(!found.rowCount)return null;
    const claimed=await client.query(`UPDATE winback_offers SET status='processing',attempts=attempts+1,processing_started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[found.rows[0].id]);
    return{...claimed.rows[0],cooldownDays:cfg.cooldownDays,offerDays:cfg.offerDays};
  });
}

async function suppress(id,reason){await query(`UPDATE winback_offers SET status='suppressed',suppression_reason=$2,processing_started_at=NULL,updated_at=NOW() WHERE id=$1`,[id,String(reason).slice(0,160)]);return'suppressed';}
async function retryLater(id,error){await query(`UPDATE winback_offers SET status='pending',processing_started_at=NULL,last_error=$2,next_attempt_at=NOW()+make_interval(mins=>$3),updated_at=NOW() WHERE id=$1`,[id,String(error?.message||error).slice(0,1500),RETRY_MINUTES]);return'failed';}

async function customerForOffer(offer){
  return(await query(`
    SELECT c.id,c.marketing_opt_in,
           COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(au.email),'')) email,
           COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),'there') display_name
      FROM customers c LEFT JOIN app_users au ON au.id=c.user_id WHERE c.id=$1
  `,[offer.customer_id])).rows[0]||null;
}
async function recentSendExists(offer,cooldownDays){
  const row=(await query(`SELECT 1 FROM winback_offers WHERE customer_id=$1 AND id<>$2 AND sent_at>NOW()-make_interval(days=>$3) LIMIT 1`,[offer.customer_id,offer.id,cooldownDays])).rows[0];
  return Boolean(row);
}
async function recoveryDiscounts(){
  const rows=(await query(`SELECT code,winback_kind,percent_off FROM discount_codes WHERE winback_kind IN ('monthly_25','longterm_10') AND active=TRUE AND (starts_at IS NULL OR starts_at<=NOW()) AND (expires_at IS NULL OR expires_at>NOW())`)).rows;
  const byKind=new Map(rows.map(row=>[row.winback_kind,row]));
  const monthly=byKind.get('monthly_25'),longterm=byKind.get('longterm_10');
  if(!monthly||Number(monthly.percent_off)!==25||!longterm||Number(longterm.percent_off)!==10)throw new Error('System win-back discount codes are missing, inactive, or misconfigured.');
  return{monthly,longterm};
}
async function brand(){await runtimeSettings.ensureLoaded().catch(()=>{});const settings=await operations.get().catch(()=>operations.DEFAULTS);return{siteName:runtimeSettings.siteName()||'CAPTAiNFiN',publicBaseUrl:String(settings?.publicBaseUrl||'').replace(/\/+$/,'')};}
function recoveryMessage(offer,customer,branding,discounts){
  const accountUrl=branding.publicBaseUrl?`${branding.publicBaseUrl}/account`:'';
  const subject='Come back and save on your next membership';
  const reasonText=offer.trigger_reason==='payment_failed'?'Your previous paid membership ended after its payment could not be renewed.':'Your previous paid membership has now ended.';
  const text=`Hi ${customer.display_name},\n\n${reasonText}\n\nIf you would like to come back, we have saved two one-time offers for you:\n\n• 25% off your first monthly payment — code ${discounts.monthly.code}\n• 10% off your first 6-month or yearly term — code ${discounts.longterm.code}\n\nThe offer is tied to your account, can be used once, and expires in ${offer.offerDays} days. Future renewals return to the normal price.${accountUrl?`\n\nOpen your account: ${accountUrl}`:''}`;
  const html=renderProfessionalEmail({subject,title:'We would love to have you back',text:`${reasonText}\n\n25% off your first monthly payment — ${discounts.monthly.code}\n\n10% off your first 6-month or yearly term — ${discounts.longterm.code}\n\nThese one-time offers are tied to your account and expire in ${offer.offerDays} days. Future renewals return to the normal price.`,eventLabel:'Win-back offer',actionLabel:accountUrl?'Choose your plan':'',actionUrl:accountUrl,siteName:branding.siteName,publicBaseUrl:branding.publicBaseUrl,transactional:false});
  return{subject,text,html};
}

async function processOne(offer){
  try{
    const customer=await customerForOffer(offer);
    if(!customer)return suppress(offer.id,'customer_missing');
    if(!customer.marketing_opt_in)return suppress(offer.id,'marketing_opt_out');
    if(!customer.email)return suppress(offer.id,'no_email');
    if(await hasActivePaidOverlap({query},offer.customer_id,offer.service_type))return suppress(offer.id,'paid_access_restored_before_send');
    if(await recentSendExists(offer,offer.cooldownDays))return suppress(offer.id,'90_day_cooldown');
    const [branding,discounts]=await Promise.all([brand(),recoveryDiscounts()]),message=recoveryMessage(offer,customer,branding,discounts);
    await emailOutbox.enqueue({type:'winback_offer',to:customer.email,subject:message.subject,text:message.text,html:message.html,dedupeKey:`winback:${offer.id}:email`});
    await query(`UPDATE winback_offers SET status='sent',sent_at=NOW(),expires_at=NOW()+make_interval(days=>$2),processing_started_at=NULL,last_error=NULL,updated_at=NOW() WHERE id=$1`,[offer.id,offer.offerDays]);
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('marketing.winback.send','winback_offer',$1,$2::jsonb)`,[offer.id,JSON.stringify({customerId:offer.customer_id,triggerSubscriptionId:offer.trigger_subscription_id,triggerReason:offer.trigger_reason,serviceType:offer.service_type,offerDays:offer.offerDays,cooldownDays:offer.cooldownDays})]);
    return'sent';
  }catch(error){return retryLater(offer.id,error);}
}

async function expireSent(){const result=await query(`UPDATE winback_offers SET status='expired',updated_at=NOW() WHERE status='sent' AND expires_at<=NOW() AND (reserved_checkout_intent_id IS NULL OR reservation_expires_at<=NOW()) RETURNING id`);return result.rowCount;}
async function run({limit=100}={}){
  const discovered=await discoverCandidates({limit:Math.max(200,Number(limit)||100)}),expired=await expireSent();
  let processed=0,sent=0,failed=0,suppressed=0;
  for(let i=0;i<Math.max(1,Math.min(500,Number(limit)||100));i+=1){const offer=await claimOne();if(!offer)break;processed+=1;const outcome=await processOne(offer);if(outcome==='sent')sent+=1;else if(outcome==='suppressed')suppressed+=1;else failed+=1;}
  return{discovered,expired,processed,sent,suppressed,failed};
}

async function availableOffer(db,customerId){
  return(await db.query(`SELECT * FROM winback_offers WHERE customer_id=$1 AND status='sent' AND expires_at>NOW() ORDER BY sent_at DESC LIMIT 1 FOR UPDATE`,[customerId])).rows[0]||null;
}
async function planById(db,planId){return(await db.query(`SELECT id,code,billing_interval,service_type,is_free_tier,price_minor FROM plans WHERE id=$1 LIMIT 1`,[planId])).rows[0]||null;}
async function assertOfferEligibility(db,{kind,customerId,planId}){
  const offer=await availableOffer(db,customerId);
  if(!offer)throw exposed('This win-back offer is not available for this account','WINBACK_NOT_AVAILABLE');
  const plan=await planById(db,planId);
  if(!plan||Number(plan.price_minor||0)<=0||plan.is_free_tier)throw exposed('This win-back offer does not apply to this plan','WINBACK_PLAN_NOT_ELIGIBLE');
  if(!planMatchesKind(kind,plan))throw exposed('This win-back offer does not apply to this billing interval','WINBACK_INTERVAL_NOT_ELIGIBLE');
  if(!scopesOverlap(offer.service_type,plan.service_type))throw exposed('This win-back offer is only valid for the service that ended','WINBACK_SERVICE_NOT_ELIGIBLE');
  if(await hasActivePaidOverlap(db,customerId,plan.service_type))throw exposed('This win-back offer is only available after your previous paid access has ended','WINBACK_ACTIVE_ACCESS');
  return{offer,plan};
}
async function validateDiscountEligibility({kind,customerId,planId}){if(!kind)return null;return assertOfferEligibility({query},{kind,customerId,planId});}

async function reserveDiscountTx(client,{kind,customerId,planId,checkoutIntentId,discountCodeId}){
  if(!kind)return null;
  const {offer}=await assertOfferEligibility(client,{kind,customerId,planId});
  if(offer.reserved_checkout_intent_id&&offer.reservation_expires_at&&new Date(offer.reservation_expires_at)>new Date()&&String(offer.reserved_checkout_intent_id)!==String(checkoutIntentId))throw exposed('A win-back checkout is already in progress. Finish or cancel it before starting another one.','WINBACK_ALREADY_RESERVED');
  const intent=(await client.query(`SELECT expires_at FROM billing_checkout_intents WHERE id=$1 AND customer_id=$2 AND state='open' FOR SHARE`,[checkoutIntentId,customerId])).rows[0];
  if(!intent)throw exposed('This win-back checkout is no longer available','WINBACK_CHECKOUT_INVALID');
  await client.query(`UPDATE winback_offers SET reserved_checkout_intent_id=$2,reserved_discount_code_id=$3,reservation_expires_at=$4,updated_at=NOW() WHERE id=$1`,[offer.id,checkoutIntentId,discountCodeId,intent.expires_at]);
  return offer;
}
async function releaseCheckoutReservation(checkoutIntentId){if(!checkoutIntentId)return 0;const result=await query(`UPDATE winback_offers SET reserved_checkout_intent_id=NULL,reserved_discount_code_id=NULL,reservation_expires_at=NULL,updated_at=NOW() WHERE status='sent' AND reserved_checkout_intent_id=$1 RETURNING id`,[checkoutIntentId]);return result.rowCount;}

async function markRedeemedTx(client,{customerId,discountCodeId,subscriptionId}){
  const discount=(await client.query(`SELECT winback_kind FROM discount_codes WHERE id=$1`,[discountCodeId])).rows[0];
  if(!discount?.winback_kind)return null;
  const offer=(await client.query(`SELECT * FROM winback_offers WHERE customer_id=$1 AND status='sent' AND reserved_discount_code_id=$2 AND reservation_expires_at>NOW() ORDER BY sent_at DESC LIMIT 1 FOR UPDATE`,[customerId,discountCodeId])).rows[0];
  if(!offer)throw new Error('Win-back offer disappeared before discount settlement.');
  const updated=(await client.query(`UPDATE winback_offers SET status='redeemed',redeemed_at=NOW(),redeemed_discount_code_id=$2,redeemed_subscription_id=$3,reserved_checkout_intent_id=NULL,reserved_discount_code_id=NULL,reservation_expires_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[offer.id,discountCodeId,subscriptionId])).rows[0];
  await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('marketing.winback.redeem','winback_offer',$1,$2::jsonb)`,[offer.id,JSON.stringify({customerId,subscriptionId,discountCodeId,kind:discount.winback_kind,triggerReason:offer.trigger_reason})]);
  return updated;
}

module.exports={DEFAULT_DELAY_DAYS,DEFAULT_OFFER_DAYS,DEFAULT_COOLDOWN_DAYS,config,planMatchesKind,discoverCandidates,run,validateDiscountEligibility,reserveDiscountTx,releaseCheckoutReservation,markRedeemedTx,assertOfferEligibility};
