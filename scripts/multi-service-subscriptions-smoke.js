'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('multi-service subscriptions smoke')) process.exit(0);

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {getPool}=require('../src/db');
const state=require('../src/entitlements/subscription-state');

function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}
function staticContracts(){
  const dashboard=source('views/customer/dashboard.ejs'),checkoutJs=source('public/js/customer-checkout.js'),activity=source('src/platform/customer-activity.js'),nav=source('views/customer/_nav.ejs'),affiliate=source('views/customer/affiliate.ejs'),adminCore=source('src/platform/admin-html-core.js'),inactivity=source('src/automation/customer-inactivity.js'),subscriptionState=source('src/entitlements/subscription-state.js'),provisioning=source('src/jellyfin/resilient-provisioning.js'),migration=source('db/migrations/045_parallel_free_jellyfin_access.sql');
  assert(dashboard.includes('Your active access')&&dashboard.includes('accessRows.forEach'),'customer home must render all live subscriptions instead of one plan');
  assert(dashboard.includes("if(s&&s.is_free_tier)return'Free Server'")&&dashboard.includes("return String(s&&s.billing_interval_snapshot||s&&s.billing_interval)==='trial'?'Jellyfin trial':'Premium Jellyfin'"),'customer Home active-access summary must identify Free and Premium Jellyfin lanes');
  assert(dashboard.includes('stremioInstallUrl')&&dashboard.includes('Install in Stremio'),'customer home must expose the recovered Stremio installation link');
  assert.strictEqual((dashboard.match(/data-shared-promo/g)||[]).length,1,'customer home must have one shared promo field');
  assert(dashboard.includes('data-promo-target')&&checkoutJs.includes('data-shared-promo'),'shared promo must be copied into whichever provider form is submitted');
  assert(!dashboard.includes('discountField'),'provider-specific promo inputs must not return');
  assert(activity.includes('FROM stream_policy_events')&&!activity.includes('FROM playback_policy_events'),'Activity must query the current stream-policy event table');
  assert(!nav.includes('>Setup<')&&!nav.includes('Plan &amp; billing'),'redundant Setup and Plan & Billing navigation must stay retired');
  assert(nav.includes('href="/account/docs">Help</a>'),'customer Help must use customer-only docs');
  assert(adminCore.includes('href="/admin/docs"')&&!adminCore.includes('class="topHelpLink" href="/help"'),'admin Help must use admin-only docs');
  assert(affiliate.indexOf('Your referral link')<affiliate.indexOf('Available'),'Benefits must show the referral link before credit metrics');
  assert(inactivity.includes("ja.access_lane='free'")&&inactivity.includes('ph.server_id=ja.server_id'),'Free inactivity must use only Free-lane server playback');
  assert(!inactivity.includes("s.source='free_claim'"),'Free inactivity candidates must not depend on how Free access was acquired');
  assert(subscriptionState.includes("h.hold_type='inactivity_policy'")&&subscriptionState.includes("ja.access_lane='free'"),'Free entitlement blocking must recognize source-agnostic Free-lane inactivity and cleanup holds');
  assert(inactivity.includes("reason:'premium_jellyfin_active'"),'paid Jellyfin portal visits must not resurrect an abandoned Free account');
  assert(provisioning.includes("'reconcile','started'")&&!provisioning.includes("'reconcile_multi_access','started'"),'multi-access provisioning runs must use a schema-valid action');
  assert(migration.includes("CHECK (access_lane IN ('primary','free'))")&&migration.includes("p_source='free_claim'"),'applied migration must remain unchanged while runtime supplements legacy-source Free blocking');
}

(async()=>{
  staticContracts();
  const pool=getPool(),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const customer=(await client.query(`INSERT INTO customers(display_name,email) VALUES('Multi Service Test','multi-service@example.invalid') RETURNING id`)).rows[0];
    const plans={};
    plans.free=(await client.query(`SELECT id FROM plans WHERE is_free_tier=TRUE LIMIT 1`)).rows[0];
    assert(plans.free,'clean install must provide the permanent Free Server plan');
    for(const spec of [['premiumTrial','Multi Premium Trial','trial',0,'jellyfin',false,'premium'],['stremioTrial','Multi Stremio Trial','trial',0,'stremio',false,'premium'],['premiumPaid','Multi Premium Paid','month',600,'jellyfin',false,'premium'],['stremioPaid','Multi Stremio Paid','month',300,'stremio',false,'premium']]){const[key,name,interval,price,serviceType,isFree,serverClass]=spec;plans[key]=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,service_type,is_free_tier) VALUES($1,$2,'direct',$3,30,$4,'USD',1,$5,TRUE,TRUE,$6,$7) RETURNING id`,[`multi-${key.toLowerCase()}`,name,interval,price,serverClass,serviceType,isFree])).rows[0];}
    const free=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '1 day','9999-12-31') RETURNING id`,[customer.id,plans.free.id])).rows[0];
    const premiumTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[customer.id,plans.premiumTrial.id])).rows[0];
    const stremioTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[customer.id,plans.stremioTrial.id])).rows[0];

    let jellyfin=(await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0],stremio=(await client.query(`SELECT subscription_id FROM effective_stremio_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(premiumTrial.id),'Premium Jellyfin trial must overlay permanent Free Server');
    assert.strictEqual(String(stremio.subscription_id),String(stremioTrial.id),'Stremio trial must coexist with the Jellyfin entitlement');
    let freeLane=await state.liveFreeJellyfinSubscription(customer.id,{client});
    assert.strictEqual(String(freeLane.subscription_id),String(free.id),'Free Server must remain independently discoverable while Premium trial is active');

    await client.query(`UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 second' WHERE id=$1`,[premiumTrial.id]);
    jellyfin=(await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(free.id),'Free Server must become effective again after Premium trial expiry');

    const premiumPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days','sub_multi_jellyfin') RETURNING id`,[customer.id,plans.premiumPaid.id])).rows[0];
    freeLane=await state.liveFreeJellyfinSubscription(customer.id,{client});
    assert.strictEqual(String(freeLane.subscription_id),String(free.id),'Free Server must remain live beside paid Premium Jellyfin');
    await state.assertNoOtherLiveRecurring(client,customer.id,premiumPaid.id,plans.stremioPaid.id);
    const stremioPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days','I-MULTI-STREMIO') RETURNING id`,[customer.id,plans.stremioPaid.id])).rows[0];
    await assert.rejects(()=>state.assertNoOtherLiveRecurring(client,customer.id,null,plans.stremioPaid.id),/recurring Stremio subscription is already active/i,'same-service recurring duplicates must still be rejected');

    await client.query(`INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata) VALUES($1,'payment_delinquency','stripe:sub_multi_jellyfin','test delinquency','{}'::jsonb)`,[customer.id]);
    jellyfin=(await client.query(`SELECT subscription_id,blocked FROM effective_customer_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];stremio=(await client.query(`SELECT subscription_id,blocked FROM effective_stremio_entitlements WHERE customer_id=$1`,[customer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(free.id),'Jellyfin delinquency must fall back to healthy Free Server access');assert.strictEqual(jellyfin.blocked,false);assert.strictEqual(String(stremio.subscription_id),String(stremioPaid.id),'Jellyfin delinquency must not block independent Stremio access');assert.strictEqual(stremio.blocked,false);

    const migratedCustomer=(await client.query(`INSERT INTO customers(display_name,email) VALUES('Migrated Free Test','migrated-free@example.invalid') RETURNING id`)).rows[0];
    const migratedFree=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','migration',NOW()-INTERVAL '30 days','9999-12-31') RETURNING id`,[migratedCustomer.id,plans.free.id])).rows[0];
    let migratedLane=await state.liveFreeJellyfinSubscription(migratedCustomer.id,{client});
    assert.strictEqual(String(migratedLane.subscription_id),String(migratedFree.id),'Migrated Free Server access must be discovered exactly like a modern Free claim');
    await client.query(`INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata) VALUES($1,'inactivity_policy',$2,'test migrated Free inactivity','{}'::jsonb)`,[migratedCustomer.id,`plan:${plans.free.id}`]);
    migratedLane=await state.liveFreeJellyfinSubscription(migratedCustomer.id,{client,includeBlocked:true});
    assert.strictEqual(String(migratedLane.subscription_id),String(migratedFree.id));assert.strictEqual(migratedLane.blocked,true,'Migrated Free access must honor a plan-scoped inactivity hold');
    assert.strictEqual(await state.liveFreeJellyfinSubscription(migratedCustomer.id,{client}),null,'Blocked migrated Free access must disappear from normal Free entitlement lookup');
    const migratedPremium=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days') RETURNING id`,[migratedCustomer.id,plans.premiumPaid.id])).rows[0];
    jellyfin=(await client.query(`SELECT subscription_id,blocked FROM effective_customer_entitlements WHERE customer_id=$1`,[migratedCustomer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(migratedPremium.id),'A Free inactivity hold must not block simultaneous Premium Jellyfin');assert.strictEqual(jellyfin.blocked,false);

    const upgradeCustomer=(await client.query(`INSERT INTO customers(display_name,email) VALUES('Trial Upgrade Test','trial-upgrade@example.invalid') RETURNING id`)).rows[0];
    const livePremiumTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[upgradeCustomer.id,plans.premiumTrial.id])).rows[0];
    const liveStremioTrial=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'trialing','manual',NOW(),NOW()+INTERVAL '7 days') RETURNING id`,[upgradeCustomer.id,plans.stremioTrial.id])).rows[0];
    await state.assertNoOtherLiveRecurring(client,upgradeCustomer.id,null,plans.premiumPaid.id);const earlyPremiumPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days','sub_trial_upgrade_jellyfin') RETURNING id`,[upgradeCustomer.id,plans.premiumPaid.id])).rows[0];
    await state.assertNoOtherLiveRecurring(client,upgradeCustomer.id,null,plans.stremioPaid.id);const earlyStremioPaid=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days','I-TRIAL-UPGRADE-STREMIO') RETURNING id`,[upgradeCustomer.id,plans.stremioPaid.id])).rows[0];
    jellyfin=(await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1`,[upgradeCustomer.id])).rows[0];stremio=(await client.query(`SELECT subscription_id FROM effective_stremio_entitlements WHERE customer_id=$1`,[upgradeCustomer.id])).rows[0];
    assert.strictEqual(String(jellyfin.subscription_id),String(earlyPremiumPaid.id),'Customer must be able to subscribe to Premium before the Jellyfin trial ends');assert.strictEqual(String(stremio.subscription_id),String(earlyStremioPaid.id),'Customer must be able to subscribe to Stremio before the Stremio trial ends');assert.notStrictEqual(String(jellyfin.subscription_id),String(livePremiumTrial.id));assert.notStrictEqual(String(stremio.subscription_id),String(liveStremioTrial.id));

    await client.query('ROLLBACK');console.log('multi-service subscriptions smoke: ok');
  }catch(error){try{await client.query('ROLLBACK');}catch(_error){}throw error;}finally{client.release();await pool.end();}
})().catch(error=>{console.error(error);process.exit(1);});