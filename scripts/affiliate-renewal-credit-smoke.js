'use strict';
require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {query,getPool}=require('../src/db');
const accounting=require('../src/payments/service-credit-accounting');
const renewals=require('../src/payments/service-credit-renewals');
const credits=require('../src/affiliate-credits');
const referrals=require('../src/referrals');
const incidents=require('../src/payments/incidents');

function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}
async function bareCustomer(label,suffix){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${label}-${suffix}@example.invalid`])).rows[0];}
async function testPlan(code,name,priceMinor){return(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[code,name,priceMinor])).rows[0];}

async function main(){
  const stripeSource=source('src/payments/stripe.js'),affiliateRoute=source('src/platform/customer-affiliate.js'),runtimeRoles=source('scripts/configure-runtime-db-roles.js'),affiliateSource=source('src/affiliate-credits.js');
  assert(stripeSource.includes("case 'invoice.created'"),'Stripe invoice.created must own renewal credit application.');
  assert(stripeSource.includes('stripe.invoiceItems.create'),'Stripe renewal credit must adjust the exact draft invoice.');
  assert(stripeSource.includes('amount:-Number(reservation.amountMinor)'),'Stripe renewal credit must reduce provider amount by the reserved credit.');
  assert(stripeSource.includes('stripe.invoiceItems.list({invoice:String(invoiceId),limit:100})'),'Provider/local recovery must verify the durable Stripe invoice item after ambiguous application.');
  assert(stripeSource.includes('recoverServiceCreditProviderItem'),'Stripe renewal handling must converge an applied provider adjustment when the local write was interrupted.');
  assert(stripeSource.includes("case 'invoice.paid'"),'Stripe invoice.paid must settle the reserved credit.');
  assert(stripeSource.includes("case 'invoice.voided'")&&stripeSource.includes("case 'invoice.deleted'"),'Terminal void/deleted invoices must release renewal credit.');
  assert(!stripeSource.includes("case 'invoice.marked_uncollectible': if(object?.id)await renewalCredits.releaseStripeInvoice"),'Uncollectible invoices can later be paid, so their already-applied credit must remain committed.');
  assert(stripeSource.includes('automatic_tax_not_supported'),'Automatic-tax invoices must fail closed instead of adding an incompatible negative invoice item.');
  assert(affiliateRoute.includes('serviceCreditReservations.availableMinor'),'Customer affiliate balances must display actually spendable credit after checkout and renewal reservations.');
  assert(runtimeRoles.includes("'affiliate_credit_ledger','affiliate_credit_renewal_reservations'"),'Generic automation cleanup must not receive DELETE on durable renewal-credit financial state.');
  assert(affiliateSource.includes('FROM affiliate_credit_renewal_reservations')&&affiliateSource.includes('open checkout or renewal invoice'),'Affiliate reward reversal must defer while a renewal owns service credit.');

  const suffix=Date.now().toString(36);
  const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'x','customer',TRUE) RETURNING id`,[`renewal-credit-${suffix}`,`renewal-credit-${suffix}@example.invalid`])).rows[0];
  const customer=(await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,`Renewal Credit ${suffix}`,`renewal-credit-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`,[customer.id]);
  await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',1000,'adjustment','available',$2,'renewal credit smoke seed')`,[customer.id,`renewal-credit-seed-${suffix}`]);
  const plan=await testPlan(`renewal-credit-plan-${suffix}`,'Renewal credit plan',600);
  const sub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot) VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '29 days',600,'GBP','Renewal credit plan','jellyfin') RETURNING id`,[customer.id,plan.id,`sub_renewal_credit_${suffix}`])).rows[0];

  const unsupported=await renewals.reserveStripeInvoice({providerInvoiceId:`in_credit_${suffix}_jpy`,providerSubscriptionId:`sub_renewal_credit_${suffix}`,currency:'JPY',maxAmountMinor:100});
  assert.equal(unsupported.reason,'unsupported_currency','unsupported invoice currency must never fall back to a different service-credit currency');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_renewal_reservations WHERE provider_invoice_id=$1`,[`in_credit_${suffix}_jpy`])).rows[0].n),0,'unsupported currency must not create a renewal reservation');

  const first=await renewals.reserveStripeInvoice({providerInvoiceId:`in_credit_${suffix}_1`,providerSubscriptionId:`sub_renewal_credit_${suffix}`,currency:'GBP',maxAmountMinor:600});
  assert.equal(first.reserved,true,'first Stripe renewal must reserve service credit');
  assert.equal(first.amountMinor,600,'renewal should reserve up to the invoice amount');
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),400,'reserved renewal credit must be unavailable to other spending paths');

  const duplicate=await renewals.reserveStripeInvoice({providerInvoiceId:`in_credit_${suffix}_1`,providerSubscriptionId:`sub_renewal_credit_${suffix}`,currency:'GBP',maxAmountMinor:600});
  assert.equal(duplicate.id,first.id,'duplicate invoice.created delivery must reuse the same reservation');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_renewal_reservations WHERE provider_invoice_id=$1`,[`in_credit_${suffix}_1`])).rows[0].n),1,'duplicate invoice.created must not reserve credit twice');

  const second=await renewals.reserveStripeInvoice({providerInvoiceId:`in_credit_${suffix}_2`,providerSubscriptionId:`sub_renewal_credit_${suffix}`,currency:'GBP',maxAmountMinor:500});
  assert.equal(second.amountMinor,400,'a concurrent renewal reservation may use only the remaining spendable balance');
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),0,'concurrent reservations must exhaust rather than overdraw credit');
  await renewals.releaseStripeInvoice(`in_credit_${suffix}_2`,'smoke_release');
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),400,'unpaid terminal invoice must release its reserved credit');

  await renewals.markStripeApplied({providerInvoiceId:`in_credit_${suffix}_1`,providerAdjustmentId:`ii_credit_${suffix}_1`});
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),400,'provider-applied credit must remain reserved until the invoice is paid');
  const consumed=await renewals.consumeStripeInvoice({providerInvoiceId:`in_credit_${suffix}_1`,providerAdjustmentId:`ii_credit_${suffix}_1`});
  assert.equal(consumed.state,'consumed');
  const debit=(await query(`SELECT id,amount_minor,applied_subscription_id,metadata FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1`,[`stripe-renewal:in_credit_${suffix}_1`])).rows[0];
  assert(debit,'paid renewal must create a durable redeemed ledger debit');
  assert.equal(Number(debit.amount_minor),-600,'renewal debit must equal the provider credit exactly');
  assert.equal(String(debit.applied_subscription_id),String(sub.id),'renewal debit must point to the subscription it funded');
  assert.equal(debit.metadata.providerInvoiceId,`in_credit_${suffix}_1`);
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),400,'after settlement only the unspent balance should remain');

  await renewals.consumeStripeInvoice({providerInvoiceId:`in_credit_${suffix}_1`,providerAdjustmentId:`ii_credit_${suffix}_1`});
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1`,[`stripe-renewal:in_credit_${suffix}_1`])).rows[0].n),1,'duplicate invoice.paid must not consume renewal credit twice');

  const finalReservation=await renewals.reserveStripeInvoice({providerInvoiceId:`in_credit_${suffix}_3`,providerSubscriptionId:`sub_renewal_credit_${suffix}`,currency:'GBP',maxAmountMinor:400});
  assert.equal(finalReservation.amountMinor,400);
  await renewals.releaseStripeInvoice(`in_credit_${suffix}_3`,'invoice_voided');
  assert.equal(await accounting.rawAvailableMinorForClient({query},customer.id,'GBP'),400,'voided invoice credit must become spendable again');

  // Refund/chargeback reconciliation must not invalidate credit that Stripe already owns on a renewal invoice.
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardPercent:25,qualificationDelayDays:0,refundWindowDays:0})]);
  const affiliate=await bareCustomer(`renewal-reversal-affiliate`,suffix),referred=await bareCustomer(`renewal-reversal-buyer`,suffix);await credits.enroll(affiliate.id);
  const purchasePlan=await testPlan(`renewal-reversal-purchase-${suffix}`,'Renewal reversal purchase',10000),code=(await query(`SELECT code FROM referral_codes WHERE customer_id=$1`,[affiliate.id])).rows[0].code;
  await referrals.attributeReferral(referred.id,code);
  const purchaseSub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,price_minor_snapshot,currency_snapshot,commercial_snapshot) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',$3,10000,'GBP',$4::jsonb) RETURNING *`,[referred.id,purchasePlan.id,`sub_reward_purchase_${suffix}`,JSON.stringify({discountedMinor:10000})])).rows[0];
  const reward=await referrals.rewardIfQualifying(referred.id);assert.equal(reward?.amountMinor,2500,'reversal fixture must create £25 service credit');
  const redemption=(await query(`SELECT id FROM referral_redemptions WHERE referred_customer_id=$1`,[referred.id])).rows[0];
  const affiliatePlan=await testPlan(`renewal-reversal-sub-${suffix}`,'Renewal reversal subscription',600),affiliateSub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot) VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',600,'GBP') RETURNING *`,[affiliate.id,affiliatePlan.id,`sub_reward_owner_${suffix}`])).rows[0];
  const held=await renewals.reserveStripeInvoice({providerInvoiceId:`in_reward_owner_${suffix}`,providerSubscriptionId:`sub_reward_owner_${suffix}`,currency:'GBP',maxAmountMinor:600});assert.equal(held.amountMinor,600);
  const recorded=await incidents.record({provider:'stripe',eventId:`evt_reward_refund_${suffix}`,caseId:`case_reward_refund_${suffix}`,kind:'refund',status:'recorded',identity:{scope:'direct',customerId:referred.id},providerSubscriptionId:purchaseSub.provider_subscription_id,amountMinor:10000,currency:'GBP',metadata:{originalAmountMinor:10000,fullRefund:true}});
  await assert.rejects(()=>credits.reverseReward({redemptionId:redemption.id,paymentIncidentId:recorded.incident.id,reason:`stripe:refund:renewal-held:${suffix}`}),error=>error?.code==='AFFILIATE_CREDIT_RESERVATION_PENDING','reward reversal must defer while credit is held by a renewal invoice');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='reversed'`,[affiliate.id])).rows[0].n),0,'deferred renewal-held reversal must not partially mutate the ledger');
  await renewals.releaseStripeInvoice(`in_reward_owner_${suffix}`,'smoke_refund_reconcile');
  const reconciled=await credits.reverseReward({redemptionId:redemption.id,paymentIncidentId:recorded.incident.id,reason:`stripe:refund:renewal-released:${suffix}`});assert.equal(reconciled.reversed,true,'released renewal reservation must allow reward reconciliation to converge');
  assert(affiliateSub.id,'affiliate renewal subscription fixture must exist');

  console.log('affiliate renewal credit smoke: ok — durable reserve, provider recovery, paid consume, refund deferral, release and duplicate guards');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
