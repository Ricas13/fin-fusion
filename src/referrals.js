'use strict';

const crypto=require('crypto');
const {query,transaction}=require('./db');
const affiliateCredits=require('./affiliate-credits');
const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY_MS=86400000;

function generateCode(length=8){let code='';for(const byte of crypto.randomBytes(length))code+=CODE_ALPHABET[byte%CODE_ALPHABET.length];return code;}
async function ensureReferralCode(customerId){
  const existing=await query('SELECT code FROM referral_codes WHERE customer_id=$1',[customerId]);if(existing.rowCount)return existing.rows[0].code;
  for(let attempt=0;attempt<5;attempt++){const code=generateCode();try{return(await query('INSERT INTO referral_codes(customer_id,code) VALUES($1,$2) RETURNING code',[customerId,code])).rows[0].code;}catch(error){if(error.code!=='23505')throw error;const found=await query('SELECT code FROM referral_codes WHERE customer_id=$1',[customerId]);if(found.rowCount)return found.rows[0].code;}}
  throw new Error('Could not generate a referral code');
}
async function sameIdentity(referrerId,referredId,client=null){
  const db=client||{query};const people=await db.query(`SELECT id,LOWER(TRIM(COALESCE(email,''))) email FROM customers WHERE id=ANY($1::uuid[])`,[[referrerId,referredId]]);if(people.rowCount<2)return true;
  const emails=new Map(people.rows.map(r=>[String(r.id),r.email]));if(emails.get(String(referrerId))&&emails.get(String(referrerId))===emails.get(String(referredId)))return true;
  const shared=await db.query(`SELECT 1 FROM payment_customers a JOIN payment_customers b ON b.provider=a.provider AND b.provider_customer_id=a.provider_customer_id WHERE a.customer_id=$1 AND b.customer_id=$2 LIMIT 1`,[referrerId,referredId]);return shared.rowCount>0;
}
async function attributeReferral(referredCustomerId,rawCode,client=null){
  const db=client||{query},code=String(rawCode||'').trim().toUpperCase();if(!code)return null;const referral=await db.query(`SELECT rc.id,rc.customer_id FROM referral_codes rc WHERE rc.code=$1`,[code]);if(!referral.rowCount||String(referral.rows[0].customer_id)===String(referredCustomerId))return null;if(await sameIdentity(referral.rows[0].customer_id,referredCustomerId,client))return null;
  const inserted=await db.query(`INSERT INTO referral_redemptions(referral_code_id,referred_customer_id,status) VALUES($1,$2,'pending') ON CONFLICT(referred_customer_id) DO NOTHING RETURNING referral_code_id`,[referral.rows[0].id,referredCustomerId]);if(inserted.rowCount)return inserted.rows[0].referral_code_id;const existing=await db.query(`SELECT referral_code_id FROM referral_redemptions WHERE referred_customer_id=$1 LIMIT 1`,[referredCustomerId]);return existing.rows[0]?.referral_code_id||null;
}
async function loadSettings(){return affiliateCredits.loadSettings();}
async function attributionEnabled(client=null){if(!client)return(await loadSettings()).enabled;const settings=await client.query("SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'");return settings.rows[0]?.setting_value?.enabled===true;}

function cumulativeRefundMinor(provider,rows){
  const amounts=rows.filter(row=>row.incident_type==='refund').map(row=>Math.max(0,Number(row.amount_minor||0)));
  return provider==='stripe'?(amounts.length?Math.max(...amounts):0):amounts.reduce((a,b)=>a+b,0);
}

async function rewardIfQualifying(referredCustomerId){
  const settings=await loadSettings();if(!settings.enabled)return null;
  return transaction(async client=>{
    const pending=await client.query(`SELECT rr.id,rr.referral_code_id,rr.created_at,rc.customer_id AS referrer_customer_id FROM referral_redemptions rr JOIN referral_codes rc ON rc.id=rr.referral_code_id WHERE rr.referred_customer_id=$1 AND rr.status='pending' LIMIT 1 FOR UPDATE OF rr`,[referredCustomerId]);if(!pending.rowCount)return null;const redemption=pending.rows[0];
    if(await sameIdentity(redemption.referrer_customer_id,referredCustomerId,client)){await client.query(`UPDATE referral_redemptions SET status='unfulfilled',reward_note='Affiliate referral rejected: accounts share an email/payment identity.' WHERE id=$1`,[redemption.id]);return{rewarded:false,reason:'same_identity'};}
    const paid=await client.query(`SELECT s.id,s.source,s.starts_at,s.current_period_end,s.provider_subscription_id,COALESCE(s.currency_snapshot,p.currency,'GBP') currency,CASE WHEN (s.commercial_snapshot->>'discountedMinor') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'discountedMinor')::int ELSE COALESCE(s.price_minor_snapshot,p.price_minor,0)::int END AS paid_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 AND s.source IN('stripe','paypal','plisio') AND s.superseded_by IS NULL AND s.status='active' AND (CASE WHEN (s.commercial_snapshot->>'discountedMinor') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'discountedMinor')::int ELSE COALESCE(s.price_minor_snapshot,p.price_minor,0)::int END)>0 ORDER BY s.starts_at,s.created_at LIMIT 1`,[referredCustomerId]);if(!paid.rowCount)return{rewarded:false,pending:true,reason:'no_qualifying_paid_event'};
    const qualifying=paid.rows[0],waitDays=Math.max(settings.qualificationDelayDays,settings.refundWindowDays),eligibleAt=new Date(new Date(qualifying.starts_at).getTime()+waitDays*DAY_MS);
    const adverse=await client.query(`SELECT incident_type,incident_status,amount_minor FROM payment_incidents WHERE customer_id=$1 AND provider=$2 AND created_at>=$3 AND provider_subscription_id=$4 AND incident_type IN('refund','chargeback','dispute') ORDER BY created_at,id`,[referredCustomerId,qualifying.source,qualifying.starts_at,qualifying.provider_subscription_id]);
    const chargeback=adverse.rows.some(row=>row.incident_type==='chargeback'||String(row.incident_status||'').toLowerCase()==='lost');
    if(chargeback){await client.query(`UPDATE referral_redemptions SET status='unfulfilled',reward_note='Affiliate credit rejected after chargeback/lost dispute evidence.' WHERE id=$1`,[redemption.id]);return{rewarded:false,reason:'payment_reversed'};}
    const unresolved=adverse.rows.some(row=>row.incident_type==='dispute'&&!['won','resolved','lost'].includes(String(row.incident_status||'').toLowerCase()));if(unresolved){await client.query(`UPDATE referral_redemptions SET reward_note='Affiliate credit waiting: qualifying payment has an unresolved dispute.' WHERE id=$1`,[redemption.id]);return{rewarded:false,pending:true,reason:'payment_dispute'};}
    const grossPaidMinor=Number(qualifying.paid_minor),refundedMinor=Math.min(grossPaidMinor,cumulativeRefundMinor(qualifying.source,adverse.rows)),netPaidMinor=Math.max(0,grossPaidMinor-refundedMinor);
    if(netPaidMinor<=0){await client.query(`UPDATE referral_redemptions SET status='unfulfilled',reward_note='Affiliate credit rejected because the qualifying payment was fully refunded.' WHERE id=$1`,[redemption.id]);return{rewarded:false,reason:'payment_reversed'};}
    const risk=await client.query(`SELECT 1 FROM customer_access_holds WHERE customer_id=$1 AND hold_type='payment_risk' AND released_at IS NULL LIMIT 1`,[referredCustomerId]);if(risk.rowCount){await client.query(`UPDATE referral_redemptions SET reward_note='Affiliate credit waiting: referred account has an unresolved payment-risk hold.' WHERE id=$1`,[redemption.id]);return{rewarded:false,pending:true,reason:'payment_risk'};}
    const reward=Math.max(1,Math.floor(netPaidMinor*settings.rewardPercent/100));await client.query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE) ON CONFLICT(customer_id) DO UPDATE SET active=TRUE,disabled_at=NULL,updated_at=NOW()`,[redemption.referrer_customer_id]);
    const ledger=await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,referred_customer_id,qualifying_subscription_id,available_at,reference_id,note,metadata) VALUES($1,$2,$3,'earned',$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING id`,[redemption.referrer_customer_id,String(qualifying.currency||'GBP').toUpperCase(),reward,eligibleAt<=Date.now()?'available':'pending',redemption.id,referredCustomerId,qualifying.id,eligibleAt,`affiliate:${redemption.id}`,`Affiliate reward: ${settings.rewardPercent}% of net qualifying paid service`,JSON.stringify({paidMinor:netPaidMinor,grossPaidMinor,refundedMinorAtQualification:refundedMinor,rewardPercent:settings.rewardPercent,provider:qualifying.source})]);
    await client.query(`UPDATE referral_redemptions SET status='rewarded',rewarded_at=NOW(),reward_note=$2 WHERE id=$1`,[redemption.id,`${reward} ${String(qualifying.currency||'GBP').toUpperCase()} minor units of affiliate service credit recorded from ${netPaidMinor} minor units of net qualifying paid value${eligibleAt>Date.now()?` (available ${eligibleAt.toISOString()})`:''}.`]);
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.reward','customer',$1,$2::jsonb)`,[redemption.referrer_customer_id,JSON.stringify({redemptionId:redemption.id,referredCustomerId,qualifyingSubscriptionId:qualifying.id,grossPaidMinor,refundedMinor,netPaidMinor,rewardMinor:reward,currency:String(qualifying.currency||'GBP').toUpperCase(),rewardPercent:settings.rewardPercent,ledgerCreated:Boolean(ledger.rowCount)})]);
    return{rewarded:true,amountMinor:reward,currency:String(qualifying.currency||'GBP').toUpperCase(),availableAt:eligibleAt};
  });
}

async function revisitRewardAfterAdversePayment({referredCustomerId,incidentId=null,reason='payment_reversal'}={}){
  if(!referredCustomerId)return{reversed:false,reason:'no_customer'};const r=await query(`SELECT rr.id FROM referral_redemptions rr WHERE rr.referred_customer_id=$1 AND rr.status IN('rewarded','reversed') ORDER BY rr.rewarded_at DESC LIMIT 1`,[referredCustomerId]);if(!r.rowCount)return{reversed:false,reason:'no_rewarded_referral'};
  const out=await affiliateCredits.reverseReward({redemptionId:r.rows[0].id,paymentIncidentId:incidentId,reason});
  if(out.reversed||out.reason==='already_reconciled'){
    const fullyReversed=Number(out.remainingRewardMinor||0)===0,status=fullyReversed?'reversed':'rewarded';
    const note=fullyReversed?`Qualifying paid value was fully reversed. Removed ${out.amountMinor||0} ${out.currency||''} minor units of unspent affiliate credit; already-delivered service was preserved, and ${out.recoverableMinor||0} is tracked separately as recoverable affiliate value.`:`Qualifying paid value changed. Reward reconciled to ${out.remainingRewardMinor} ${out.currency||''} minor units; this event removed ${out.amountMinor||0} unspent units and already-delivered service was preserved.`;
    await query(`UPDATE referral_redemptions SET status=$2,reward_note=$3 WHERE id=$1`,[r.rows[0].id,status,note]);
  }
  return out;
}

function unusedExtensionDays(){return 0;}
async function processDueRewards({limit=100}={}){await affiliateCredits.matureDueCredits();const rows=await query(`SELECT referred_customer_id FROM referral_redemptions WHERE status='pending' ORDER BY created_at LIMIT $1`,[Math.max(1,Math.min(500,Number(limit)||100))]);let rewarded=0,pending=0,failed=0;for(const row of rows.rows){try{const out=await rewardIfQualifying(row.referred_customer_id);if(out?.rewarded)rewarded++;else pending++;}catch(error){failed++;console.warn('Affiliate qualification retry failed:',error.message);}}return{processed:rows.rowCount,rewarded,pending,failed};}

module.exports={ensureReferralCode,attributeReferral,rewardIfQualifying,revisitRewardAfterAdversePayment,unusedExtensionDays,processDueRewards,loadSettings,attributionEnabled,sameIdentity,cumulativeRefundMinor};