'use strict';

require('dotenv').config();
const assert=require('assert');
const transfer=require('../src/platform/configuration-transfer');
const {query,getPool}=require('../src/db');

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');

  const expectedAffiliate={enabled:true,rewardPercent:22,qualificationDelayDays:9,refundWindowDays:14};
  const expectedDrift={healthyMinutes:300,driftMinutes:45,failureBaseMinutes:20,failureMaxMinutes:400,batchSize:250};
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedAffiliate)]);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('jellyfin_drift_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedDrift)]);

  const exported=await transfer.exportPortableConfiguration();
  assert.strictEqual(exported.version,2,'portable export must use v2');
  assert.deepStrictEqual(exported.configuration.settings.affiliate_program,expectedAffiliate,'affiliate programme settings must be portable');
  assert.deepStrictEqual(exported.configuration.settings.jellyfin_drift_policy,expectedDrift,'drift policy settings must be portable');
  for(const plan of exported.configuration.plans||[]){
    assert(!Object.keys(plan).some(key=>key.includes('credit_cost')),'retired credit-cost plan fields must not be exported');
  }

  const preview=await transfer.previewImport(exported);
  assert(preview.digest,'preview must produce a digest');
  assert.strictEqual(Number(preview.summary.affiliateProgram||0),1,'preview must recognize affiliate settings');
  assert.strictEqual(Number(preview.summary.driftPolicy||0),1,'preview must recognize drift policy settings');

  // Damage the local values so applyImport proves settings are actually
  // restored, rather than merely serialized in the export.
  await query(`UPDATE platform_settings SET setting_value=$2::jsonb WHERE setting_key=$1`,['affiliate_program',JSON.stringify({enabled:false,rewardPercent:1,qualificationDelayDays:0,refundWindowDays:0})]);
  await query(`UPDATE platform_settings SET setting_value='{}'::jsonb WHERE setting_key='jellyfin_drift_policy'`);

  const result=await transfer.applyImport(exported,null);
  assert.strictEqual(result.summary.atomic,true,'configuration import must remain atomic');

  const restoredAffiliate=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredAffiliate,expectedAffiliate,'affiliate programme settings did not round-trip');
  const restoredDrift=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='jellyfin_drift_policy'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredDrift,expectedDrift,'drift policy settings did not round-trip');

  console.log('Configuration transfer settings round-trip passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
