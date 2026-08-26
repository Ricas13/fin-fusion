'use strict';

const assert=require('assert');
const {getPool}=require('../src/db');
const state=require('../src/entitlements/subscription-state');

(async()=>{
  const pool=getPool(),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const customer=(await client.query(`INSERT INTO customers(display_name,email) VALUES('Multi Service Test','multi-service@example.invalid') RETURNING id`)).rows[0];
    const plans={};
    for(const spec of [
      ['free','Multi Free Server','month',0,'jellyfin',true,'free'],
      ['premiumTrial','Multi Premium Trial','trial',0,'jellyfin',false,'premium'],
      ['stremioTrial','Multi Stremio Trial','trial',0,'stremio',false,'premium'],
      ['premiumPaid','Multi Premium Paid','month',600,'jellyfin',false,'premium'],
      ['stremioPaid','Multi Stremio Paid','month',300,'stremio',false,'premium']
    ]){
      const [key,name,interval,price,serviceType,isFree,serverClass]=spec;
      plans[key]=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,service_type,is_free_tier) VALUES($1,$2,'direct',$3,30,$4,'USD',1,$5,TRUE,TRUE,$6,$7) RETURNING id`,[`multi-${key.toLowerCase()}`,name,interval,price,serverClass,serviceType,isFree])).rows[0];
    }
    const free=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '1 day','9999-12-31') RETURNING id`,[customer.id,plans.free.id])).rows[0];
    const premiumTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[customer.id,plans.premiumTrial.id])).rows[0];
    const stremioTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[customer.id,plans.stremioTrial.id])).rows[0];

    let jellyfin=(await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    let stremio=(await client.query(`SELECT subscription_id FROM effective_stremio_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(premiumTrial.id),'Premium Jellyfin trial must overlay permanent Free Server');
    assert.strictEqual(String(stremio.subscription_id),String(stremioTrial.id),'Stremio trial must coexist with the Jellyfin entitlement');

    await client.query(`UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 second' WHERE id=$1`,[premiumTrial.id]);
    jellyfin=(await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(free.id),'Free Server must become effective again after Premium trial expiry');

    const premiumPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe',NOW(),NOW()+INTERVAL '30 days','sub_multi_jellyfin') RETURNING id`,[customer.id,plans.premiumPaid.id])).rows[0];
    await state.assertNoOtherLiveRecurring(client,customer.id,premiumPaid.id,plans.stremioPaid.id);
    const stremioPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal',NOW(),NOW()+INTERVAL '30 days','I-MULTI-STREMIO') RETURNING id`,[customer.id,plans.stremioPaid.id])).rows[0];
    await assert.rejects(()=>state.assertNoOtherLiveRecurring(client,customer.id,null,plans.stremioPaid.id),/recurring Stremio subscription is already active/i,'same-service recurring duplicates must still be rejected');

    await client.query(`INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata) VALUES($1,'payment_delinquency','stripe:sub_multi_jellyfin','test delinquency','{}'::jsonb)`,[customer.id]);
    jellyfin=(await client.query(`SELECT subscription_id,blocked FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    stremio=(await client.query(`SELECT subscription_id,blocked FROM effective_stremio_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(free.id),'Jellyfin delinquency must fall back to healthy Free Server access');
    assert.strictEqual(jellyfin.blocked,false);
    assert.strictEqual(String(stremio.subscription_id),String(stremioPaid.id),'Jellyfin delinquency must not block independent Stremio access');
    assert.strictEqual(stremio.blocked,false);

    await client.query('ROLLBACK');
    console.log('multi-service subscriptions smoke: ok');
  }catch(error){
    try{await client.query('ROLLBACK');}catch(_error){}
    throw error;
  }finally{
    client.release();
    await pool.end();
  }
})().catch(error=>{console.error(error);process.exit(1);});
