'use strict';

// Opt-in only after every web and webhook worker runs this version. A prepared
// intent is settled even if the flag is subsequently turned off.
const {previewFromEvidence,readEvidence}=require('../../scripts/paid-value-preview');
const {fetchRate,quoteConversion}=require('./paid-value-conversion');
const {stripeClient,paypalRequest}=require('./provider-refund-adapters');
const {addPlanDuration}=require('./billing-periods');
const DAY=86400000;
function enabled(){return process.env.PAID_VALUE_TRANSFER_ENABLED==='true';}
function invariant(ok,message){if(!ok){const e=new Error(message);e.code='PAID_VALUE_TRANSFER_SETTLEMENT_CONFLICT';throw e;}}
function currency(v){return String(v||'').trim().toUpperCase();}
function minor(v){const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v??''));return m?(BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0'))).toString():null;}
function time(v){return new Date(v).getTime();}
function stripeId(v){return typeof v==='string'?v:v?.id;}
function metadataMatches(meta,row){return meta?.internal_checkout_intent_id===row.intent_id&&meta?.internal_customer_id===row.customer_id&&meta?.internal_plan_id===row.plan_id;}
async function verifySource(row,evidence,adapters={stripeClient,paypalRequest}){
 const ref=row.provider_subscription_id;
 const paid=evidence.providerPaidMinor,c=evidence.currency;
 if(row.source==='stripe'){
   const stripe=await adapters.stripeClient();
   const pi=await stripe.paymentIntents.retrieve(ref,{expand:['latest_charge']});
   const ch=pi.latest_charge;
   invariant(pi.id===ref&&pi.status==='succeeded'&&String(pi.amount_received)===paid&&currency(pi.currency)===c&&metadataMatches(pi.metadata,row)&&
     ch&&typeof ch==='object'&&ch.paid===true&&ch.captured===true&&ch.disputed===false&&ch.amount_refunded===0&&String(ch.amount)===paid&&currency(ch.currency)===c,
     'Original Stripe payment is not conclusively paid and unreversed.');
 }else if(row.source==='paypal'){
   const capture=await adapters.paypalRequest('/v2/payments/captures/'+encodeURIComponent(ref));
   const order=await adapters.paypalRequest('/v2/checkout/orders/'+encodeURIComponent(row.intent_provider_checkout_id));
   const captures=(order.purchase_units||[]).flatMap(u=>u.payments?.captures||[]);
   invariant(capture.id===ref&&capture.status==='COMPLETED'&&minor(capture.amount?.value)===paid&&currency(capture.amount?.currency_code)===c&&
     order.id===row.intent_provider_checkout_id&&order.status==='COMPLETED'&&captures.length===1&&captures[0].id===ref&&captures[0].status==='COMPLETED',
     'Original PayPal capture is not conclusively paid and unreversed.');
 }else if(row.source==='plisio'){
   const plisio=require('./plisio');
   const op=plisio.operationFields(await plisio.getOperation(ref));
   invariant(op.id===ref&&op.orderNumber===row.intent_id&&op.status==='completed'&&minor(op.sourceAmount)===paid&&currency(op.sourceCurrency)===c,
     'Original Plisio payment is not conclusively paid and unreversed.');
 }else invariant(false,'Unsupported source payment provider.');
}
async function candidates(client,customerId,planId,exclude=null){
 const r=await client.query(`
 SELECT s.id,s.source,s.plan_id,COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS service_type,
        COALESCE(b.service_type,'jellyfin') AS destination_service
 FROM public.prepaid_paid_time($1) held
 JOIN subscriptions s ON s.id=held.subscription_id
 JOIN plans p ON p.id=s.plan_id JOIN plans b ON b.id=$2
 WHERE public.prepaid_lanes_overlap(held.service_type,COALESCE(b.service_type,'jellyfin'))
   AND s.id IS DISTINCT FROM $3::uuid
 ORDER BY s.id`,[customerId,planId,exclude]);
 return r.rows;
}
async function destination(client,planId,snapshot){
 // The first execution path supports normal base prices only. An access
 // variant needs its own authoritative price mapping, never the base price.
 invariant(!snapshot.accessVariantId&&snapshot.kind==='direct_plan'&&snapshot.checkoutMode==='subscription'&&snapshot.provider==='stripe',
   'Destination is not supported by automatic monetary transfer.');
 const r=await client.query(`
 SELECT pr.id AS "priceId",pr.price_minor AS "normalPriceMinor",pr.currency,p.billing_interval AS "billingInterval"
 FROM plan_prices pr JOIN plans p ON p.id=pr.plan_id
 WHERE p.id=$1 AND pr.id=$2 AND pr.active=TRUE AND pr.price_minor>0 AND p.active=TRUE AND p.visible=TRUE
   AND p.archived_at IS NULL AND p.audience IN ('direct','both')
   AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
   AND (p.effective_from IS NULL OR p.effective_from<=NOW()) AND (p.effective_until IS NULL OR p.effective_until>NOW())
 `,[planId,snapshot.planPriceId]);
 const d=r.rows[0];
 invariant(r.rowCount===1&&String(d.normalPriceMinor)===String(snapshot.priceMinor)&&currency(d.currency)===currency(snapshot.currency)&&d.billingInterval===snapshot.billingInterval,'Normal destination price is unverified.');
 return {...d,normalPriceMinor:String(d.normalPriceMinor),currency:currency(d.currency)};
}
async function evidenceFor(client,source,customerId,sourceVerifier=verifySource){
 await client.query('SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[source.id,customerId]);
 const row=await readEvidence(client,source.id),e=previewFromEvidence(row);
 invariant(row?.customer_id===customerId&&e.verified===true&&e.serviceCreditPaidMinor==='0','Original cash purchase cannot be valued conclusively.');
 await sourceVerifier(row,e);
 return {row,e};
}
async function prepare(client,{customerId,planId,snapshot},{sourceVerifier=verifySource,rateFetcher=fetchRate}={}){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[customerId]);
 const held=await candidates(client,customerId,planId);
 invariant(held.length===1&&held[0].service_type===held[0].destination_service,'Several or different service entitlements require review.');
 const target=await destination(client,planId,snapshot);
 const {e}=await evidenceFor(client,held[0],customerId,sourceVerifier);
 const rate=await rateFetcher(e.currency,target.currency);
 const quote=quoteConversion(e,target,{rate});
 return {version:1,sourceId:held[0].id,planId,target,providerMappingId:snapshot.providerMappingId,preview:quote};
}
async function verifyTarget(row,intent,prepared,adapter=stripeClient){
 const stripe=await adapter();
 const sub=await stripe.subscriptions.retrieve(row.provider_subscription_id,{expand:['latest_invoice','items.data.price']});
 const session=await stripe.checkout.sessions.retrieve(intent.provider_checkout_id);
 const item=sub.items?.data?.[0],invoice=sub.latest_invoice;
 invariant(sub.id===row.provider_subscription_id&&sub.status==='active'&&sub.items?.data?.length===1&&
   item?.price?.id===prepared.providerMappingId&&String(item.price.unit_amount)===prepared.target.normalPriceMinor&&
   currency(item.price.currency)===prepared.target.currency&&item.quantity===1&&
   sub.metadata?.internal_checkout_intent_id===intent.id&&sub.metadata?.internal_customer_id===row.customer_id&&sub.metadata?.internal_plan_id===row.plan_id&&
   session.id===intent.provider_checkout_id&&session.mode==='subscription'&&session.status==='complete'&&
   session.payment_status==='paid'&&stripeId(session.subscription)===sub.id&&session.amount_total>0&&currency(session.currency)===prepared.target.currency&&
   invoice&&typeof invoice==='object'&&invoice.status==='paid'&&invoice.billing_reason==='subscription_create'&&
   Number(item.current_period_start)*1000===time(row.starts_at)&&Number(item.current_period_end)*1000===time(row.current_period_end)&&
   time(addPlanDuration(prepared.target,row.starts_at))===time(row.current_period_end),
   'New recurring payment or initial billing period is not conclusively verified.');
}
function ratio(quote,e){
 // Exact rational seconds-to-seconds conversion, used again for reversals.
 let n=BigInt(quote.exactDays.numerator)*BigInt(DAY);
 let d=BigInt(quote.exactDays.denominator)*BigInt(e.unusedMilliseconds);
 let a=n,b=d;while(b){const r=a%b;a=b;b=r;}return {numerator:(n/a).toString(),denominator:(d/a).toString()};
}
async function settlePrepared(client,row,{sourceVerifier=verifySource,targetVerifier=verifyTarget,rateFetcher=fetchRate}={}){
 const id=row.commercial_snapshot?.checkoutIntentId;
 if(!id)return null;
 const intent=(await client.query('SELECT id,customer_id,plan_id,provider,checkout_mode,provider_checkout_id,paid_value_transfer_snapshot FROM billing_checkout_intents WHERE id=$1 FOR UPDATE',[id])).rows[0];
 const prepared=intent?.paid_value_transfer_snapshot;
 if(!prepared)return null;
 invariant(prepared.version===1&&intent.customer_id===row.customer_id&&intent.plan_id===row.plan_id&&prepared.planId===row.plan_id&&
   intent.provider==='stripe'&&row.source==='stripe'&&intent.checkout_mode==='subscription'&&row.status==='active'&&
   !row.superseded_by&&!row.refund_terminated_at&&Number(row.service_extension_days||0)===0&&time(row.current_period_end)>Date.now(),
   'Prepared transfer does not match the receiving entitlement.');
 const snapshot=row.commercial_snapshot;
 invariant(!snapshot.accessVariantId&&String(snapshot.planPriceId)===prepared.target.priceId&&String(snapshot.priceMinor)===prepared.target.normalPriceMinor&&
   currency(snapshot.currency)===prepared.target.currency&&snapshot.billingInterval===prepared.target.billingInterval&&snapshot.providerMappingId===prepared.providerMappingId,
   'The paid checkout differs from the prepared normal price.');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[row.customer_id]);
 await targetVerifier(row,intent,prepared);
 const held=await candidates(client,row.customer_id,row.plan_id,row.id);
 invariant(held.length<=1&&(!held.length||(held[0].id===prepared.sourceId&&held[0].service_type===held[0].destination_service)),
   'Remaining access changed after checkout preparation.');
 if(!held.length){
   const source=(await client.query('SELECT id,current_period_end,service_extension_days,superseded_by,refund_terminated_at FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[prepared.sourceId,row.customer_id])).rows[0];
   invariant(source&&!source.superseded_by&&!source.refund_terminated_at&&Number(source.service_extension_days||0)===0&&time(source.current_period_end)<=Date.now(),'Prepared source is missing or changed.');
   return {row,problem:null};
 }
 const {row:source,e}=await evidenceFor(client,held[0],row.customer_id,sourceVerifier);
 const rate=await rateFetcher(e.currency,prepared.target.currency);
 const quote=quoteConversion(e,prepared.target,{rate,termStart:row.starts_at});
 const fraction=ratio(quote,e),from=new Date(Math.max(time(e.startsAt),time(e.asOf))).toISOString();
 const audit={...quote,quoteOnly:false,ratio:fraction,sourceProviderPaidMinor:e.providerPaidMinor,sourceIntentId:source.intent_id,checkoutIntentId:id};
 invariant(quote.addedDays>0&&quote.addedDays<=3650,'Converted value is outside the supported limit.');
 const ledger=await client.query(`
 INSERT INTO subscription_time_carryovers(customer_id,target_subscription_id,source_subscription_id,source_provider,source_payment_ref,
   window_start,window_end,carried_seconds,applied_days,value_ratio,target_first_period_end,reason,value_transfer_quote)
 VALUES($1,$2,$3,$4,$5,$6,$7,FLOOR(EXTRACT(EPOCH FROM ($7::timestamptz-$6::timestamptz)))::bigint,$8,
   $9::numeric/$10::numeric,$11,'monetary_plan_transfer',$12::jsonb) RETURNING id`,
 [row.customer_id,row.id,source.id,source.source,source.provider_subscription_id,from,e.endsAt,quote.addedDays,fraction.numerator,fraction.denominator,row.current_period_end,JSON.stringify(audit)]);
 invariant(ledger.rowCount===1,'Transfer ledger was not created.');
 const replaced=await client.query(`UPDATE subscriptions SET superseded_by=$1,replaced_at=NOW(),replacement_reason='paid_time_carried',updated_at=NOW()
 WHERE id=$2 AND customer_id=$3 AND superseded_by IS NULL AND refund_terminated_at IS NULL`,[row.id,source.id,row.customer_id]);
 invariant(replaced.rowCount===1,'Original entitlement changed during settlement.');
 const updated=await client.query(`UPDATE subscriptions SET service_extension_days=$2,updated_at=NOW()
 WHERE id=$1 AND customer_id=$3 AND service_extension_days=0 RETURNING *`,[row.id,quote.addedDays,row.customer_id]);
 invariant(updated.rowCount===1,'Receiving entitlement changed during settlement.');
 await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('subscription.paid_value.transferred','subscription',$1,$2::jsonb)`,
 [row.id,JSON.stringify({customerId:row.customer_id,sourceSubscriptionId:source.id,ledgerId:ledger.rows[0].id,quote:audit})]);
 return {row:updated.rows[0],problem:null};
}
module.exports={enabled,prepare,settlePrepared,verifySource,verifyTarget,ratio,minor};
