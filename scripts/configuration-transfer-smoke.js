'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const transfer=require('../src/platform/configuration-transfer');
const {query,getPool}=require('../src/db');

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const suffix=crypto.randomBytes(4).toString('hex'),retiredCode=`retired-${suffix}`;

  // Historical reseller rows may remain in a live database, but the retired
  // product must never be carried into a new portable configuration.
  await query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active) VALUES($1,$2,'historical reseller data',1200,'GBP',8,2,42,TRUE,TRUE)`,[retiredCode,`Retired ${suffix}`]);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('reseller_defaults_v2',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify({legacy:true})]);
  const expectedAffiliate={enabled:true,rewardPercent:22,qualificationDelayDays:9,refundWindowDays:14};
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedAffiliate)]);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('jellyfin_drift_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify({healthyMinutes:360,driftMinutes:60,failureBaseMinutes:15,failureMaxMinutes:360,batchSize:100})]);

  const exported=await transfer.exportPortableConfiguration();
  assert.strictEqual(exported.version,2,'portable export must use v2');
  assert.deepStrictEqual(exported.configuration.resellerTiers,[],'retired reseller tiers must not be exported');
  assert(!Object.prototype.hasOwnProperty.call(exported.configuration.settings,'reseller_defaults'),'legacy reseller defaults must not be exported');
  assert(!Object.prototype.hasOwnProperty.call(exported.configuration.settings,'reseller_defaults_v2'),'reseller v2 defaults must not be exported');
  assert.deepStrictEqual(exported.configuration.settings.affiliate_program,expectedAffiliate,'affiliate programme settings must be portable');
  for(const plan of exported.configuration.plans||[]){
    assert(!Object.prototype.hasOwnProperty.call(plan,'reseller_credit_cost'),'retired reseller credit fields must not be exported');
    assert(!Object.prototype.hasOwnProperty.call(plan,'reseller_trial_credit_cost'),'retired reseller trial-credit fields must not be exported');
  }

  const preview=await transfer.previewImport(exported);
  assert(preview.digest,'preview must produce a digest');
  assert.strictEqual(Number(preview.summary.resellerTiersCreate||0),0,'preview must not offer retired reseller creation');
  assert.strictEqual(Number(preview.summary.resellerTiersUpdate||0),0,'preview must not offer retired reseller updates');
  assert.strictEqual(Number(preview.summary.affiliateProgram||0),1,'preview must recognize affiliate settings');

  // Change the local value so applyImport proves the exported affiliate policy
  // is actually restored rather than merely serialized.
  await query(`UPDATE platform_settings SET setting_value=$2::jsonb WHERE setting_key=$1`,['affiliate_program',JSON.stringify({enabled:false,rewardPercent:1,qualificationDelayDays:0,refundWindowDays:0})]);
  const result=await transfer.applyImport(exported,null);
  assert.strictEqual(result.summary.atomic,true,'configuration import must remain atomic');
  const restored=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restored,expectedAffiliate,'affiliate programme settings did not round-trip');
  assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM reseller_tiers WHERE code=$1`,[retiredCode])).rows[0].n),1,'historical reseller data must be preserved in-place, not destructively deleted');

  console.log('Configuration transfer affiliate replacement contract passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
