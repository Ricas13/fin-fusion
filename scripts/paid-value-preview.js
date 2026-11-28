'use strict';

// Evidence-only operator preview. Never an entitlement authority or a write path.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable(reason){return {verified:false,reason};}
function minor(value){
 if(value==null||!/^\d+$/.test(String(value)))return null;
 const n=BigInt(value);
 return n<=BigInt(Number.MAX_SAFE_INTEGER)?n:null;
}
function ms(value){if(value==null)return NaN;return new Date(value).getTime();}
// An applied credit reservation alone is insufficient: prove the immutable
// debit and every funding allocation, and refuse disputed source rewards.
function verifiedCredit(row,contract,intent,currency){
 const credit=minor(contract.serviceCreditMinor??0);
 if(credit===null||minor(intent.serviceCreditMinor??0)!==credit)return null;
 const records=row.credit_records||[];
 if(credit===0n)return records.length===0?0n:null;
 const cash=minor(contract.discountedMinor),gross=minor(contract.grossDiscountedMinor);
 if(cash===null||gross===null||gross!==cash+credit||minor(intent.grossDiscountedMinor)!==gross||
    minor(contract.priceMinor)===null||gross>minor(contract.priceMinor)||minor(intent.priceMinor)!==minor(contract.priceMinor)||
    contract.serviceCreditCurrency!==currency||intent.serviceCreditCurrency!==currency||records.length!==1)return null;
 const record=records[0],allocated=minor(record.allocated_minor);
 if(record.exact_identity!==true||record.funding_verified!==true||
    minor(record.reserved_minor)!==credit||minor(record.debited_minor)!==credit||allocated!==credit)return null;
 return credit;
}
function previewFromEvidence(row){
 if(!row)return unavailable('subscription_not_found');
 if(row.billing_mode!=='payment'||!['stripe','paypal','plisio'].includes(row.source)||row.status!=='active'||
    row.is_addon||row.is_free_tier||row.superseded_by||row.refund_terminated_at||row.permanent_or_operator_present)
   return unavailable('unsupported_entitlement');
 if(Number(row.service_extension_days)!==0||row.has_extension_history||row.has_carry_history)
   return unavailable('separate_paid_time_requires_allocation');
 if(row.has_adverse_incident||row.has_adverse_financial_history||row.has_open_plan_change)
   return unavailable('adverse_or_open_change_requires_review');
 if(!row.term_matches)return unavailable('original_term_unverified');
 const contract=row.commercial_snapshot||{},intent=row.intent_snapshot||{};
 const currency=String(contract.currency||'').toUpperCase();
 if(!row.intent_id||row.intent_state!=='completed'||contract.checkoutIntentId!==row.intent_id||
    contract.kind!=='direct_plan'||intent.kind!=='direct_plan'||contract.checkoutMode!=='payment'||intent.checkoutMode!=='payment'||
    contract.planId!==row.plan_id||intent.planId!==row.plan_id||contract.provider!==row.source||intent.provider!==row.source||
    !/^[A-Z]{3}$/.test(currency)||String(intent.currency||'').toUpperCase()!==currency||
    String(row.currency_snapshot||'').trim().toUpperCase()!==currency)
   return unavailable('checkout_contract_unverified');
 const credit=verifiedCredit(row,contract,intent,currency);
 if(credit===null)return unavailable('service_credit_evidence_unverified');
 const paid=minor(contract.discountedMinor),intentPaid=minor(intent.discountedMinor);
 if(paid===null||paid<=0n||intentPaid!==paid)
   return unavailable('cash_amount_unverified');
 const records=row.payment_records||[];
 if(records.length!==1)return unavailable('payment_missing_or_ambiguous');
 const payment=records[0];
 if(minor(payment.gross_amount_minor)!==paid||String(payment.currency||'').toUpperCase()!==currency)
   return unavailable('payment_amount_or_currency_mismatch');
 const start=ms(row.starts_at),end=ms(row.current_period_end),now=ms(row.as_of);
 if(![start,end,now].every(Number.isSafeInteger)||end<=start)return unavailable('invalid_period');
 const total=BigInt(end-start),unused=BigInt(Math.max(0,end-Math.max(start,now)));
 if(unused===0n)return unavailable('no_unused_time');
 // Exact rational value in currency minor units. No rounding policy applied.
 const numerator=(paid+credit)*unused,denominator=total;
 return {verified:true,currency,providerPaidMinor:paid.toString(),serviceCreditPaidMinor:credit.toString(),
   remainingCashValueMinor:{numerator:(paid*unused).toString(),denominator:denominator.toString()},
   remainingServiceCreditValueMinor:{numerator:(credit*unused).toString(),denominator:denominator.toString()},
   remainingValueMinor:{numerator:numerator.toString(),denominator:denominator.toString()},
   unusedMilliseconds:unused.toString(),originalMilliseconds:total.toString(),
   startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),asOf:new Date(now).toISOString()};
}
async function readEvidence(client,subscriptionId){
 if(!UUID.test(String(subscriptionId||'')))throw new Error('A subscription UUID is required.');
 const result=await client.query(`
  SELECT s.*,p.is_addon,p.is_free_tier,NOW() AS as_of,
    i.id::text AS intent_id,i.provider_checkout_id AS intent_provider_checkout_id,i.state AS intent_state,i.commercial_snapshot AS intent_snapshot,
    (s.current_period_end AT TIME ZONE 'UTC')=
      CASE s.commercial_snapshot->>'billingInterval'
       WHEN 'month' THEN (s.starts_at AT TIME ZONE 'UTC')+INTERVAL '1 month'
       WHEN '6_months' THEN (s.starts_at AT TIME ZONE 'UTC')+INTERVAL '6 months'
       WHEN 'year' THEN (s.starts_at AT TIME ZONE 'UTC')+INTERVAL '1 year'
       ELSE NULL END AS term_matches,
    EXISTS(SELECT 1 FROM customer_entitlement_overrides o WHERE o.customer_id=s.customer_id AND o.subscription_id=s.id AND o.revoked_at IS NULL AND o.permanent_access=TRUE)
      OR public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
      OR public.subscription_admin_present(s.customer_id,'emby',s.id)
      OR public.subscription_admin_present(s.customer_id,'stremio',s.id) AS permanent_or_operator_present,
    EXISTS(SELECT 1 FROM subscription_access_extensions e WHERE e.subscription_id=s.id) AS has_extension_history,
    EXISTS(SELECT 1 FROM subscription_time_carryovers c WHERE c.source_subscription_id=s.id OR c.target_subscription_id=s.id) AS has_carry_history,
    EXISTS(SELECT 1 FROM customer_plan_changes pc WHERE pc.current_subscription_id=s.id AND pc.state='pending') AS has_open_plan_change,
    EXISTS(SELECT 1 FROM payment_incidents pi WHERE pi.provider=s.source AND pi.provider_subscription_id=s.provider_subscription_id
      AND pi.incident_type IN ('refund','chargeback','dispute')) AS has_adverse_incident,
    EXISTS(SELECT 1 FROM payment_history_transactions adverse
      WHERE adverse.provider=s.source AND (adverse.provider_reference_id=s.provider_subscription_id
        OR adverse.provider_transaction_id=s.provider_subscription_id OR adverse.metadata->>'checkoutIntentId'=i.id::text
        OR (s.source='stripe' AND EXISTS(SELECT 1 FROM payment_history_transactions charge WHERE charge.provider='stripe'
             AND charge.provider_reference_id=s.provider_subscription_id AND charge.provider_source_id=adverse.provider_source_id)))
      AND (adverse.gross_amount_minor<0 OR LOWER(adverse.transaction_type) IN ('refund','chargeback','reversal','dispute'))) AS has_adverse_financial_history,
    COALESCE(pay.records,'[]'::jsonb) AS payment_records,
    COALESCE(credit.records,'[]'::jsonb) AS credit_records
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id
  LEFT JOIN billing_checkout_intents i ON i.id::text=s.commercial_snapshot->>'checkoutIntentId'
    AND i.customer_id=s.customer_id AND i.plan_id=s.plan_id AND i.provider=s.source AND i.scope='customer' AND i.checkout_mode='payment'
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('gross_amount_minor',t.gross_amount_minor::text,'currency',t.currency)) AS records
    FROM payment_history_transactions t
    WHERE t.customer_id=s.customer_id AND t.provider=s.source AND t.gross_amount_minor>0
      AND t.metadata->>'providerAuthoritative'='true'
      AND ((s.source='stripe' AND t.provider_reference_id=s.provider_subscription_id
             AND t.transaction_type='charge' AND t.transaction_status IN ('available','pending')
             AND t.metadata->>'liveStripeSync'='true' AND t.metadata->>'checkoutIntentId'=i.id::text)
        OR (s.source='paypal' AND t.provider_transaction_id=s.provider_subscription_id
             AND t.transaction_status='S' AND t.metadata->>'livePaypal'='true'
             AND t.metadata->>'providerCaptureStatus'='COMPLETED' AND t.provider_reference_id=i.provider_checkout_id)
        OR (s.source='plisio' AND t.provider_transaction_id=s.provider_subscription_id
             AND t.transaction_status='completed' AND t.transaction_type='payment'
             AND t.metadata->>'providerVerified'='true' AND t.metadata->>'checkoutIntentId'=i.id::text
             AND t.provider_transaction_id=i.provider_checkout_id))
  ) pay ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'reserved_minor',r.amount_minor::text,'debited_minor',(-d.amount_minor::bigint)::text,
      'allocated_minor',COALESCE(funding.total,0)::text,
      'exact_identity',COALESCE(r.state='applied' AND r.applied_at IS NOT NULL
        AND r.customer_id=s.customer_id AND r.currency=s.currency_snapshot
        AND d.customer_id=s.customer_id AND d.currency=s.currency_snapshot
        AND d.entry_type='redeemed' AND d.state='available' AND d.amount_minor<0
        AND d.metadata->>'checkoutIntentId'=i.id::text AND d.metadata->>'reservationId'=r.id::text
        AND d.applied_subscription_id IS NULL,FALSE),
      'funding_verified',COALESCE(funding.valid,FALSE))) AS records
    FROM affiliate_credit_checkout_reservations r
    LEFT JOIN affiliate_credit_ledger d ON d.entry_type='redeemed' AND d.reference_id='mixed-checkout:'||i.id::text
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount_minor) AS total,BOOL_AND(
        a.customer_id=s.customer_id AND a.currency=s.currency_snapshot
        AND g.customer_id=s.customer_id AND g.currency=s.currency_snapshot
        AND g.state='available' AND g.amount_minor>0 AND g.entry_type IN ('earned','adjustment')
        AND (g.available_at IS NULL OR g.available_at<=d.created_at)
        AND g.created_at<=d.created_at
        AND (SELECT COALESCE(SUM(other.amount_minor),0) FROM affiliate_credit_allocations other
             WHERE other.grant_ledger_id=g.id)<=g.amount_minor
        AND NOT EXISTS(SELECT 1 FROM affiliate_credit_recoveries rec
          WHERE rec.source_reward_id=g.id OR rec.source_reward_id::text=g.metadata->>'sourceRewardId')
        AND NOT EXISTS(SELECT 1 FROM affiliate_credit_ledger reversal
          WHERE reversal.entry_type='reversed' AND reversal.state<>'void'
            AND (reversal.metadata->>'sourceRewardId'=g.id::text
              OR reversal.metadata->>'earnedCreditId'=g.id::text
              OR reversal.metadata->>'sourceRewardId'=g.metadata->>'sourceRewardId'
              OR reversal.metadata->>'earnedCreditId'=g.metadata->>'sourceRewardId'))
        AND (g.metadata->>'sourceRewardId' IS NULL OR EXISTS(
          SELECT 1 FROM affiliate_credit_ledger root
          WHERE root.id::text=g.metadata->>'sourceRewardId' AND root.customer_id=s.customer_id
            AND root.currency=s.currency_snapshot AND root.entry_type='earned'
            AND root.state='available' AND root.amount_minor>0))) AS valid
      FROM affiliate_credit_allocations a JOIN affiliate_credit_ledger g ON g.id=a.grant_ledger_id
      WHERE a.debit_ledger_id=d.id
    ) funding ON TRUE
    WHERE r.checkout_intent_id=i.id
  ) credit ON TRUE WHERE s.id=$1
 `,[subscriptionId]);
 return result.rows[0]||null;
}
async function readDestination(client,priceId){
 if(!UUID.test(String(priceId||'')))throw new Error('A destination plan price UUID is required.');
 const r=await client.query(`SELECT pr.id AS "priceId",pr.price_minor AS "normalPriceMinor",pr.currency,p.billing_interval AS "billingInterval"
 FROM plan_prices pr JOIN plans p ON p.id=pr.plan_id
 WHERE pr.id=$1 AND pr.active=TRUE AND pr.price_minor>0 AND p.active=TRUE AND p.visible=TRUE
 AND p.archived_at IS NULL AND p.audience IN ('direct','both')
 AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
 AND (p.effective_from IS NULL OR p.effective_from<=NOW()) AND (p.effective_until IS NULL OR p.effective_until>NOW())`,[priceId]);
 if(r.rowCount!==1)throw new Error('Destination normal base price is unavailable.');
 return r.rows[0];
}
async function main(){
 require('dotenv').config();
 const {getPool}=require('../src/db');
 const pool=getPool();
 let client;
 try{
   client=await pool.connect();
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await client.query("SET LOCAL statement_timeout='10s'");
   const result=previewFromEvidence(await readEvidence(client,process.argv[2]));
   const target=result.verified&&process.argv[3]?await readDestination(client,process.argv[3]):null;
   await client.query('COMMIT');
   if(target){
     const conversion=require('../src/payments/paid-value-conversion');
     try{
       const rate=await conversion.fetchRate(result.currency,target.currency);
       result.conversion=conversion.quoteConversion(result,target,{rate});
     }catch(error){
       console.log(JSON.stringify({...result,conversion:{quoteOnly:true,verified:false,reason:'conversion_unavailable'}},null,2));
       return 2;
     }
   }
   console.log(JSON.stringify(result,null,2));
   return result.verified?0:2;
 }catch(_error){
   if(client)await client.query('ROLLBACK').catch(()=>{});
   console.error(JSON.stringify(unavailable('preview_unavailable')));
   return 3;
 }finally{if(client)client.release();await pool.end().catch(()=>{});}
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.exitCode=3;});
module.exports={previewFromEvidence,readEvidence};
