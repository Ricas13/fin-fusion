'use strict';

// Opt-in only after every web and webhook worker runs this version. A prepared
// intent is settled even if the flag is subsequently turned off.
const {previewFromEvidence,readEvidence}=require('../../scripts/paid-value-preview');
const {fetchRate,quoteConversion}=require('./paid-value-conversion');
const {stripeClient,paypalRequest}=require('./provider-refund-adapters');
const {addPlanDuration}=require('./billing-periods');
const creditReservations=require('./service-credit-reservations');
const DAY=86400000;
function enabled(){return process.env.PAID_VALUE_TRANSFER_ENABLED==='true';}
function invariant(ok,message){if(!ok){const e=new Error(message);e.code='PAID_VALUE_TRANSFER_SETTLEMENT_CONFLICT';throw e;}}
const CHARGE_UNSUPPORTED='This monetary plan transfer requires a verifiable first billing period. Your existing access is unchanged. You have not been charged.';
function assertChargeSupported({providerDue,serviceCreditMinor=0,grossDue=providerDue,discountCodeId=null}){
 const zero=providerDue===0&&(serviceCreditMinor>0||Boolean(discountCodeId));
 if(!Number.isSafeInteger(providerDue)||(!zero&&providerDue<50)||!Number.isSafeInteger(serviceCreditMinor)||serviceCreditMinor<0||
    !Number.isSafeInteger(grossDue)||grossDue!==providerDue+serviceCreditMinor){
   const error=new Error(CHARGE_UNSUPPORTED);
   error.expose=true;error.code='PAID_VALUE_TRANSFER_PAYMENT_UNSUPPORTED';throw error;
 }
}
function targetFunding(snapshot){
 const cash=snapshot?.discountedMinor,credit=snapshot?.serviceCreditMinor??0,gross=snapshot?.grossDiscountedMinor??cash;
 invariant(Number.isSafeInteger(cash)&&(cash>=50||(cash===0&&(credit>0||Boolean(snapshot.discountCodeId))))&&Number.isSafeInteger(credit)&&credit>=0&&
   Number.isSafeInteger(gross)&&gross===cash+credit&&gross<=snapshot.priceMinor&&
   (!credit||currency(snapshot.serviceCreditCurrency)===currency(snapshot.currency)),
   'Receiving checkout funding does not match the frozen commercial contract.');
 return {cash,credit,gross};
}
// Settle the receiving earned-credit reservation in the same transaction as
// transferring old access. The ordinary activation path also calls settle;
// it is idempotent, and a late/unfunded reservation aborts all local changes.
async function settleTargetCredit(client,row,intent){
 const {credit}=targetFunding(row.commercial_snapshot);
 const reservation=(await client.query('SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1 FOR UPDATE',[intent.id])).rows[0];
 invariant(credit?reservation&&reservation.customer_id===row.customer_id&&Number(reservation.amount_minor)===credit&&currency(reservation.currency)===currency(row.commercial_snapshot.currency):!reservation,
   'Receiving service-credit reservation does not match the paid checkout.');
 if(!credit)return;
 const applied=await creditReservations.settle(client,intent.id,'completed');
 invariant(applied?.state==='applied'&&applied.customer_id===row.customer_id&&Number(applied.amount_minor)===credit&&currency(applied.currency)===currency(row.commercial_snapshot.currency),
   'Receiving service credit was not settled.');
 const debit=(await client.query(`SELECT d.id FROM affiliate_credit_ledger d
   WHERE d.customer_id=$1 AND d.currency=$2 AND d.entry_type='redeemed' AND d.state='available'
     AND d.reference_id=$3 AND d.amount_minor=$4 AND d.metadata->>'checkoutIntentId'=$5 AND d.metadata->>'reservationId'=$6
     AND (SELECT COALESCE(SUM(a.amount_minor),0) FROM affiliate_credit_allocations a WHERE a.debit_ledger_id=d.id AND a.customer_id=d.customer_id AND a.currency=d.currency)=$7`,
   [row.customer_id,currency(row.commercial_snapshot.currency),'mixed-checkout:'+intent.id,-credit,intent.id,applied.id,credit])).rows[0];
 invariant(debit,'Receiving service-credit debit or allocation is missing.');
}
function currency(v){return String(v||'').trim().toUpperCase();}
function minor(v){const m=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v??''));return m?(BigInt(m[1])*100n+BigInt((m[2]||'').padEnd(2,'0'))).toString():null;}
function time(v){return new Date(v).getTime();}
function stripeId(v){return typeof v==='string'?v:v?.id;}
function metadataMatches(meta,row){return meta?.internal_checkout_intent_id===row.intent_id&&meta?.internal_customer_id===row.customer_id&&meta?.internal_plan_id===row.plan_id;}
async function verifySource(row,evidence,adapters={stripeClient,paypalRequest}){
 const ref=row.provider_subscription_id;
 const paid=evidence.providerPaidMinor,c=evidence.currency;
 if(row.source==='service_credit'){
   invariant(evidence.verified&&paid==='0'&&BigInt(evidence.serviceCreditPaidMinor)>0n&&!ref,'Pure-credit source lacks verified local debit evidence.');
   return;
 }
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
 // An access variant must use its own normal price and provider mapping.
 invariant(snapshot.kind==='direct_plan'&&snapshot.checkoutMode==='subscription'&&snapshot.provider==='stripe',
   'Destination is not supported by automatic monetary transfer.');
 const r=await client.query(`
 SELECT pr.id AS "priceId",
        CASE WHEN $3::uuid IS NULL THEN pr.price_minor ELSE v.price_minor END AS "normalPriceMinor",
        pr.currency,p.billing_interval AS "billingInterval",
        v.id AS "accessVariantId",v.variant_kind AS "accessVariantKind",v.quantity AS "accessQuantity"
 FROM plan_prices pr JOIN plans p ON p.id=pr.plan_id
 LEFT JOIN plan_access_variants v ON v.id=$3 AND v.plan_id=p.id AND v.currency=pr.currency AND v.active=TRUE
 WHERE p.id=$1 AND pr.id=$2 AND pr.active=TRUE AND pr.price_minor>0 AND p.active=TRUE AND p.visible=TRUE
   AND ($3::uuid IS NULL OR (v.id IS NOT NULL AND v.price_minor>0 AND
      ((v.variant_kind='streams' AND p.service_type IN ('jellyfin','bundle')) OR
       (v.variant_kind='households' AND p.service_type='stremio'))))
   AND p.archived_at IS NULL AND p.audience IN ('direct','both')
   AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
   AND (p.effective_from IS NULL OR p.effective_from<=NOW()) AND (p.effective_until IS NULL OR p.effective_until>NOW())
 `,[planId,snapshot.planPriceId,snapshot.accessVariantId||null]);
 const d=r.rows[0];
 invariant(r.rowCount===1&&String(d.normalPriceMinor)===String(snapshot.priceMinor)&&currency(d.currency)===currency(snapshot.currency)&&d.billingInterval===snapshot.billingInterval,'Normal destination price is unverified.');
 if(snapshot.accessVariantId){
   invariant(d.accessVariantId===snapshot.accessVariantId&&d.accessVariantKind===snapshot.accessVariantKind&&Number(d.accessQuantity)===Number(snapshot.accessQuantity),'Destination access variant is unverified.');
   const mapping=await client.query(`SELECT id FROM plan_access_variant_provider_prices
     WHERE id=$1 AND access_variant_id=$2 AND provider='stripe' AND checkout_mode='subscription' AND active=TRUE AND external_id=$3`,
     [snapshot.providerMappingRecordId,snapshot.accessVariantId,snapshot.providerMappingId]);
   invariant(mapping.rowCount===1,'Destination access variant provider mapping is unverified.');
 }
 return {...d,normalPriceMinor:String(d.normalPriceMinor),currency:currency(d.currency)};
}
async function evidenceFor(client,source,customerId,sourceVerifier=verifySource){
 await client.query('SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[source.id,customerId]);
 const row=await readEvidence(client,source.id),e=previewFromEvidence(row);
 invariant(row?.customer_id===customerId&&e.verified===true,'Original purchase and funding allocations cannot be valued conclusively.');
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
 return {version:1,sourceId:held[0].id,planId,target,providerMappingId:snapshot.providerMappingId,preview:{...quote,...fundingBreakdown(e,quote)}};
}
async function verifyTarget(row,intent,prepared,adapter=stripeClient){
 const funding=targetFunding(row.commercial_snapshot);
 const stripe=await adapter();
 const sub=await stripe.subscriptions.retrieve(row.provider_subscription_id,{expand:['latest_invoice','items.data.price']});
 const session=await stripe.checkout.sessions.retrieve(intent.provider_checkout_id);
 const item=sub.items?.data?.[0],invoice=sub.latest_invoice;
 invariant(sub.id===row.provider_subscription_id&&sub.status==='active'&&sub.items?.data?.length===1&&
   item?.price?.id===prepared.providerMappingId&&String(item.price.unit_amount)===prepared.target.normalPriceMinor&&
   currency(item.price.currency)===prepared.target.currency&&item.quantity===1&&
   sub.metadata?.internal_checkout_intent_id===intent.id&&sub.metadata?.internal_customer_id===row.customer_id&&sub.metadata?.internal_plan_id===row.plan_id&&
   session.id===intent.provider_checkout_id&&session.mode==='subscription'&&session.status==='complete'&&
   (funding.cash>0?session.payment_status==='paid':session.payment_status==='no_payment_required')&&stripeId(session.subscription)===sub.id&&currency(session.currency)===prepared.target.currency&&
   invoice&&typeof invoice==='object'&&invoice.status==='paid'&&invoice.billing_reason==='subscription_create'&&
   Number.isInteger(invoice.amount_paid)&&invoice.amount_paid===session.amount_total&&currency(invoice.currency)===prepared.target.currency&&
   session.amount_total===funding.cash&&
   (funding.cash>0||(session.amount_subtotal===Number(prepared.target.normalPriceMinor)&&session.total_details?.amount_discount===session.amount_subtotal&&
      invoice.total===0&&invoice.amount_due===0&&invoice.amount_remaining===0&&
      !sub.trial_end&&Boolean(stripeId(sub.default_payment_method)||stripeId(sub.default_source))))&&
   Number(item.current_period_start)*1000===time(row.starts_at)&&Number(item.current_period_end)*1000===time(row.current_period_end)&&
   time(addPlanDuration(prepared.target,row.starts_at))===time(row.current_period_end),
   'New recurring payment or initial billing period is not conclusively verified.');
}
// Keep provider cash and earned credit independently identifiable throughout
// the transfer. Credit never becomes provider-refundable cash. Both fund the
// same original entitlement, so the existing source-payment-loss policy still
// ends that entitlement (and reverses its transferred access).
function fundingBreakdown(e,quote){
 const cash=e.remainingCashValueMinor,credit=e.remainingServiceCreditValueMinor;
 const total=e.remainingValueMinor;
 invariant(cash&&credit&&total&&cash.denominator===total.denominator&&credit.denominator===total.denominator&&
   BigInt(cash.numerator)+BigInt(credit.numerator)===BigInt(total.numerator),
   'Original cash and service-credit value does not reconcile.');
 const converted=value=>({numerator:(BigInt(value.numerator)*BigInt(quote.fx.numerator)).toString(),
   denominator:(BigInt(value.denominator)*BigInt(quote.fx.denominator)).toString()});
 return {sourceProviderPaidMinor:e.providerPaidMinor,sourceServiceCreditPaidMinor:e.serviceCreditPaidMinor,
   sourceRemainingCashValueMinor:cash,sourceRemainingServiceCreditValueMinor:credit,
   destinationRemainingCashValueMinor:converted(cash),destinationRemainingServiceCreditValueMinor:converted(credit)};
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
   !row.superseded_by&&!row.refund_terminated_at&&time(row.current_period_end)>Date.now(),
   'Prepared transfer does not match the receiving entitlement.');
 const snapshot=row.commercial_snapshot;
 invariant((snapshot.accessVariantId||null)===(prepared.target.accessVariantId||null)&&
   (!snapshot.accessVariantId||(snapshot.accessVariantKind===prepared.target.accessVariantKind&&Number(snapshot.accessQuantity)===Number(prepared.target.accessQuantity)))&&
   String(snapshot.planPriceId)===prepared.target.priceId&&String(snapshot.priceMinor)===prepared.target.normalPriceMinor&&
   currency(snapshot.currency)===prepared.target.currency&&snapshot.billingInterval===prepared.target.billingInterval&&snapshot.providerMappingId===prepared.providerMappingId,
   'The paid checkout differs from the prepared normal price.');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[row.customer_id]);
 // A replay must acknowledge the original transfer, even if the source was
 // later refunded. Never create a second ledger entry or restore reversed days.
 const previous=await client.query(`SELECT id,source_subscription_id,value_transfer_quote FROM subscription_time_carryovers WHERE target_subscription_id=$1 AND value_transfer_quote IS NOT NULL`,[row.id]);
 if(previous.rowCount){
   invariant(previous.rowCount===1&&previous.rows[0].source_subscription_id===prepared.sourceId&&previous.rows[0].value_transfer_quote?.checkoutIntentId===id,'Existing transfer does not match the prepared checkout.');
   const current=(await client.query('SELECT * FROM subscriptions WHERE id=$1',[row.id])).rows[0];
   return {row:current,problem:null};
 }
 invariant(Number(row.service_extension_days||0)===0,'Receiving entitlement already has extension time.');
 await targetVerifier(row,intent,prepared);
 await settleTargetCredit(client,row,intent);
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
 const audit={...quote,quoteOnly:false,ratio:fraction,...fundingBreakdown(e,quote),sourceIntentId:source.intent_id,checkoutIntentId:id,receivingFunding:targetFunding(row.commercial_snapshot)};
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
module.exports={enabled,prepare,settlePrepared,verifySource,verifyTarget,ratio,minor,assertChargeSupported,CHARGE_UNSUPPORTED};
