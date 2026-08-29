'use strict';
require('dotenv').config();
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {query,getPool}=require('../src/db');
const accounting=require('../src/payments/service-credit-accounting');
const renewals=require('../src/payments/service-credit-renewals');

function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

async function main(){
  const stripeSource=source('src/payments/stripe.js'),affiliateRoute=source('src/platform/customer-affiliate.js');
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

  const suffix=Date.now().toString(36);
  const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'x','customer',TRUE) RETURNING id`,[`renewal-credit-${suffix}`,`renewal-credit-${suffix}@example.invalid`])).rows[0];
  const customer=(await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,`Renewal Credit ${suffix}`,`renewal-credit-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`,[customer.id]);
  await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',1000,'adjustment','available',$2,'renewal credit smoke seed')`,[customer.id,`renewal-credit-seed-${suffix}`]);
  const plan=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,'Renewal credit plan','jellyfin','direct','month',30,600,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[`renewal-credit-plan-${suffix}`])).rows[0];
  const sub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot) VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '29 days',600,'GBP','Renewal credit plan','jellyfin') RETURNING id`,[customer.id,plan.id,`sub_renewal_credit_${suffix}`])).rows[0];

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

  console.log('affiliate renewal credit smoke: ok — durable reserve, provider recovery, paid consume, release and duplicate guards');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
