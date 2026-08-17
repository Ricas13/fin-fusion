'use strict';
const assert=require('assert');
const {query,transaction,getPool}=require('../src/db');
const reservations=require('../src/payments/service-credit-reservations');
async function main(){
 const suffix=Date.now().toString(36);
 const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'x','customer',TRUE) RETURNING id`,[`mixed-${suffix}`,`mixed-${suffix}@example.invalid`])).rows[0];
 const customer=(await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,`Mixed ${suffix}`,`mixed-${suffix}@example.invalid`])).rows[0];
 await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`,[customer.id]);
 await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',400,'adjustment','available',$2,'mixed smoke')`,[customer.id,`mixed-seed-${suffix}`]);
 const plan=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,'Mixed plan','jellyfin','direct','month',30,600,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[`mixed-plan-${suffix}`])).rows[0];
 const price=(await query(`SELECT id FROM plan_prices WHERE plan_id=$1 AND currency='GBP' LIMIT 1`,[plan.id])).rows[0];
 assert(price&&price.id,'plan-price compatibility trigger must create the default GBP price');
 const intent=(await query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,plan_price_id,provider,checkout_mode,nonce_hash,expires_at,commercial_snapshot) VALUES('customer',$1,$2,$3,'stripe','payment',$4,NOW()+INTERVAL '60 minutes',$5::jsonb) RETURNING id`,[customer.id,plan.id,price.id,'smoke-nonce',JSON.stringify({kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',priceMinor:600,discountedMinor:200,currency:'GBP'})])).rows[0];
 const reserved=await reservations.reserveForIntent({customerId:customer.id,checkoutIntentId:intent.id,currency:'GBP',maxAmountMinor:550,expiresAt:new Date(Date.now()+70*60*1000)});
 assert.equal(reserved.amountMinor,400,'mixed checkout should reserve available credit');
 assert.equal(await reservations.availableMinor(customer.id,'GBP'),0,'reserved credit must not be spendable twice');
 await transaction(client=>reservations.settle(client,intent.id,'completed'));
 const spent=(await query(`SELECT amount_minor FROM affiliate_credit_ledger WHERE customer_id=$1 AND reference_id=$2`,[customer.id,`mixed-checkout:${intent.id}`])).rows[0];
 assert.equal(Number(spent.amount_minor),-400,'verified completion must consume exactly the reserved credit');
 assert.equal((await reservations.reservationForIntent(intent.id)).state,'applied');
 const second=(await query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,plan_price_id,provider,checkout_mode,nonce_hash,expires_at,commercial_snapshot) VALUES('customer',$1,$2,$3,'paypal','payment',$4,NOW()+INTERVAL '60 minutes',$5::jsonb) RETURNING id`,[customer.id,plan.id,price.id,'smoke-nonce-2',JSON.stringify({kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'paypal',checkoutMode:'payment',priceMinor:600,discountedMinor:600,currency:'GBP'})])).rows[0];
 const none=await reservations.reserveForIntent({customerId:customer.id,checkoutIntentId:second.id,currency:'GBP',maxAmountMinor:550,expiresAt:new Date(Date.now()+7*60*60*1000)});
 assert.equal(none.amountMinor,0,'spent credit must not be reusable');
 console.log('affiliate mixed-payment smoke: ok');
}
main().then(()=>getPool().end()).catch(async e=>{console.error(e.stack||e);try{await getPool().end()}catch{}process.exit(1)});
