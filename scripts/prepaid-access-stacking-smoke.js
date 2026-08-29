'use strict';
require('dotenv').config();
const assert=require('assert');
const {query,getPool}=require('../src/db');

async function makePlan(code,serviceType='jellyfin'){
  return (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$2,$3,'direct','month',30,600,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[code,code,serviceType])).rows[0];
}
async function makeCustomer(label){
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${label}@example.invalid`])).rows[0];
}
async function insertPaid({customerId,planId,source,id,startsAt,endsAt,interval='month',days=30,serviceType='jellyfin'}){
  return (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,[customerId,planId,source,id,startsAt,endsAt,interval,days,serviceType,JSON.stringify({kind:'direct_plan',checkoutMode:'payment',billingInterval:interval,durationDays:days})])).rows[0];
}
function ms(value){return new Date(value).getTime();}

async function main(){
  const suffix=Date.now().toString(36),customer=await makeCustomer(`prepaid-stack-${suffix}`),jellyfin=await makePlan(`prepaid-jf-${suffix}`,'jellyfin'),stremio=await makePlan(`prepaid-st-${suffix}`,'stremio');
  const firstStart=new Date(Date.now()-20*86400000),firstEnd=new Date(Date.now()+10*86400000);
  const first=await insertPaid({customerId:customer.id,planId:jellyfin.id,source:'stripe',id:`pi_stack_1_${suffix}`,startsAt:firstStart,endsAt:firstEnd});
  assert(Math.abs(ms(first.current_period_end)-ms(firstEnd))<1000,'first prepaid purchase should retain its original expiry');

  const second=await insertPaid({customerId:customer.id,planId:jellyfin.id,source:'paypal',id:`ORDER-STACK-2-${suffix}`,startsAt:new Date(),endsAt:new Date(Date.now()+30*86400000)});
  assert.equal(ms(second.starts_at),ms(first.current_period_end),'second prepaid purchase must begin exactly when current prepaid access ends');
  const expectedSecond=(await query(`SELECT $1::timestamptz + INTERVAL '1 month' AS t`,[first.current_period_end])).rows[0].t;
  assert.equal(ms(second.current_period_end),ms(expectedSecond),'a monthly top-up must add one calendar month from the queued expiry');

  const third=await insertPaid({customerId:customer.id,planId:jellyfin.id,source:'plisio',id:`PLISIO-STACK-3-${suffix}`,startsAt:new Date(),endsAt:new Date(Date.now()+180*86400000),interval:'6_months',days:180});
  assert.equal(ms(third.starts_at),ms(second.current_period_end),'later top-ups must queue after already queued prepaid time');
  const expectedThird=(await query(`SELECT $1::timestamptz + INTERVAL '6 months' AS t`,[second.current_period_end])).rows[0].t;
  assert.equal(ms(third.current_period_end),ms(expectedThird),'six-month top-up must add six calendar months from queued expiry');

  const stStart=new Date(),stEnd=new Date(Date.now()+30*86400000);
  const separate=await insertPaid({customerId:customer.id,planId:stremio.id,source:'stripe',id:`pi_stack_st_${suffix}`,startsAt:stStart,endsAt:stEnd,serviceType:'stremio'});
  assert(Math.abs(ms(separate.starts_at)-ms(stStart))<1000,'unrelated service access must not be pushed behind Jellyfin prepaid time');

  const recurringStart=new Date(),recurringEnd=new Date(Date.now()+31*86400000);
  const recurring=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,billing_interval_snapshot,duration_days_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','stripe',$3,$4,$5,'month',30,'jellyfin') RETURNING *`,[customer.id,jellyfin.id,`sub_stack_${suffix}`,recurringStart,recurringEnd])).rows[0];
  assert(Math.abs(ms(recurring.starts_at)-ms(recurringStart))<1000,'recurring Stripe periods must remain provider-authoritative and never be stacked');
  assert(Math.abs(ms(recurring.current_period_end)-ms(recurringEnd))<1000,'recurring Stripe expiry must remain provider supplied');

  const concurrentCustomer=await makeCustomer(`prepaid-concurrent-${suffix}`),baseEnd=new Date(Date.now()+5*86400000);
  await insertPaid({customerId:concurrentCustomer.id,planId:jellyfin.id,source:'stripe',id:`pi_concurrent_base_${suffix}`,startsAt:new Date(),endsAt:baseEnd});
  const pool=getPool();
  async function concurrentTopup(id){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const result=await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,commercial_snapshot)
        VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '1 month','month',30,'jellyfin',$4::jsonb) RETURNING *`,[concurrentCustomer.id,jellyfin.id,id,JSON.stringify({kind:'direct_plan',checkoutMode:'payment',billingInterval:'month',durationDays:30})]);
      await client.query('COMMIT');
      return result.rows[0];
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  const [a,b]=await Promise.all([concurrentTopup(`pi_concurrent_a_${suffix}`),concurrentTopup(`pi_concurrent_b_${suffix}`)]);
  const ordered=[a,b].sort((x,y)=>ms(x.starts_at)-ms(y.starts_at));
  assert.equal(ms(ordered[0].starts_at),ms(baseEnd),'first concurrent top-up must start at the pre-existing expiry');
  assert.equal(ms(ordered[1].starts_at),ms(ordered[0].current_period_end),'second concurrent top-up must serialize after the first rather than overlap it');

  console.log('prepaid access stacking smoke: ok — cumulative calendar periods, service isolation, recurring exclusion and concurrent serialization');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
