'use strict';

require('dotenv').config();
const assert=require('assert');
const transfer=require('../src/platform/configuration-transfer');
const {query,getPool}=require('../src/db');

const PLAN_COLUMNS=`service_type,capacity_limit,is_addon,streams,jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,stremio_household_lease_minutes`;

async function insertPlan(plan){
  await query(`
    INSERT INTO plans(
      code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,streams,
      allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,
      allow_4k,allow_remuxing,allow_remote_access,server_class,active,visible,sort_order,library_access_mode,
      library_names,placement_strategy,capacity_limit,is_addon,jellyfin_access_model,
      jellyfin_household_network_limit,jellyfin_household_lease_minutes,stremio_household_lease_minutes
    ) VALUES(
      $1,$2,'configuration transfer regression plan',$3,'direct','month',30,999,'GBP',$4,
      TRUE,FALSE,FALSE,FALSE,FALSE,TRUE,TRUE,TRUE,'premium',TRUE,TRUE,900,'all',ARRAY[]::text[],
      'balanced',$5,$6,$7,$8,$9,$10
    )
    ON CONFLICT(code) DO UPDATE SET
      service_type=EXCLUDED.service_type,capacity_limit=EXCLUDED.capacity_limit,is_addon=EXCLUDED.is_addon,
      streams=EXCLUDED.streams,jellyfin_access_model=EXCLUDED.jellyfin_access_model,
      jellyfin_household_network_limit=EXCLUDED.jellyfin_household_network_limit,
      jellyfin_household_lease_minutes=EXCLUDED.jellyfin_household_lease_minutes,
      stremio_household_lease_minutes=EXCLUDED.stremio_household_lease_minutes
  `,[plan.code,plan.name,plan.service_type,plan.streams,plan.capacity_limit,plan.is_addon,plan.jellyfin_access_model,plan.jellyfin_household_network_limit,plan.jellyfin_household_lease_minutes,plan.stremio_household_lease_minutes]);
}

function expectedShape(plan){
  return {
    service_type:plan.service_type,
    capacity_limit:plan.capacity_limit,
    is_addon:plan.is_addon,
    streams:plan.streams,
    jellyfin_access_model:plan.jellyfin_access_model,
    jellyfin_household_network_limit:plan.jellyfin_household_network_limit,
    jellyfin_household_lease_minutes:plan.jellyfin_household_lease_minutes,
    stremio_household_lease_minutes:plan.stremio_household_lease_minutes
  };
}

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');

  const expectedAffiliate={enabled:true,rewardPercent:22,qualificationDelayDays:9,refundWindowDays:14};
  const expectedDrift={healthyMinutes:300,driftMinutes:45,failureBaseMinutes:20,failureMaxMinutes:400,batchSize:250};
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedAffiliate)]);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('jellyfin_drift_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedDrift)]);

  const regressionPlans=[
    {code:'audit-transfer-jellyfin-streams',name:'Audit Jellyfin Streams',service_type:'jellyfin',capacity_limit:51,is_addon:false,streams:3,jellyfin_access_model:'concurrent_streams',jellyfin_household_network_limit:1,jellyfin_household_lease_minutes:240,stremio_household_lease_minutes:240},
    {code:'audit-transfer-jellyfin-household',name:'Audit Jellyfin Household',service_type:'jellyfin',capacity_limit:52,is_addon:false,streams:null,jellyfin_access_model:'household_network',jellyfin_household_network_limit:2,jellyfin_household_lease_minutes:180,stremio_household_lease_minutes:240},
    {code:'audit-transfer-stremio',name:'Audit Stremio Household',service_type:'stremio',capacity_limit:53,is_addon:true,streams:1,jellyfin_access_model:'concurrent_streams',jellyfin_household_network_limit:1,jellyfin_household_lease_minutes:240,stremio_household_lease_minutes:360},
    {code:'audit-transfer-bundle',name:'Audit Bundle Household',service_type:'bundle',capacity_limit:54,is_addon:false,streams:null,jellyfin_access_model:'household_network',jellyfin_household_network_limit:3,jellyfin_household_lease_minutes:300,stremio_household_lease_minutes:420}
  ];
  for(const plan of regressionPlans)await insertPlan(plan);

  const exported=await transfer.exportPortableConfiguration();
  assert.strictEqual(exported.version,2,'portable export must use v2');
  assert.deepStrictEqual(exported.configuration.settings.affiliate_program,expectedAffiliate,'affiliate programme settings must be portable');
  assert.deepStrictEqual(exported.configuration.settings.jellyfin_drift_policy,expectedDrift,'drift policy settings must be portable');
  for(const plan of exported.configuration.plans||[]){
    assert(!Object.keys(plan).some(key=>key.includes('credit_cost')),'retired credit-cost plan fields must not be exported');
  }
  for(const expected of regressionPlans){
    const plan=exported.configuration.plans.find(item=>item.code===expected.code);
    assert(plan,`missing exported modular plan ${expected.code}`);
    assert.deepStrictEqual(expectedShape(plan),expectedShape(expected),`${expected.code} modular fields were not exported exactly`);
  }

  const preview=await transfer.previewImport(exported);
  assert(preview.digest,'preview must produce a digest');
  assert.strictEqual(Number(preview.summary.affiliateProgram||0),1,'preview must recognize affiliate settings');
  assert.strictEqual(Number(preview.summary.driftPolicy||0),1,'preview must recognize drift policy settings');

  // Old V2 documents did not carry modular fields. They must remain accepted
  // with safe legacy defaults rather than becoming un-importable after this fix.
  const legacyV2=JSON.parse(JSON.stringify(exported));
  const legacyPlan=legacyV2.configuration.plans.find(plan=>plan.code==='audit-transfer-jellyfin-streams');
  for(const key of ['service_type','capacity_limit','is_addon','jellyfin_access_model','jellyfin_household_network_limit','jellyfin_household_lease_minutes','stremio_household_lease_minutes'])delete legacyPlan[key];
  const parsedLegacy=transfer.parseDocument(legacyV2);
  const parsedLegacyPlan=parsedLegacy.configuration.plans.find(plan=>plan.code===legacyPlan.code);
  assert.strictEqual(parsedLegacyPlan.service_type,'jellyfin','old V2 plan should default safely to Jellyfin');
  assert.strictEqual(parsedLegacyPlan.jellyfin_access_model,'concurrent_streams','old V2 plan should default safely to concurrent streams');

  // Damage local values so applyImport proves settings and plan semantics are
  // actually restored rather than merely serialized in the export.
  await query(`UPDATE platform_settings SET setting_value=$2::jsonb WHERE setting_key=$1`,['affiliate_program',JSON.stringify({enabled:false,rewardPercent:1,qualificationDelayDays:0,refundWindowDays:0})]);
  await query(`UPDATE platform_settings SET setting_value='{}'::jsonb WHERE setting_key='jellyfin_drift_policy'`);
  await query(`
    UPDATE plans SET service_type='jellyfin',capacity_limit=0,is_addon=FALSE,streams=1,
      jellyfin_access_model='concurrent_streams',jellyfin_household_network_limit=1,
      jellyfin_household_lease_minutes=240,stremio_household_lease_minutes=240
    WHERE code LIKE 'audit-transfer-%'
  `);

  const result=await transfer.applyImport(exported,null);
  assert.strictEqual(result.summary.atomic,true,'configuration import must remain atomic');

  const restoredAffiliate=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredAffiliate,expectedAffiliate,'affiliate programme settings did not round-trip');
  const restoredDrift=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='jellyfin_drift_policy'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredDrift,expectedDrift,'drift policy settings did not round-trip');

  for(const expected of regressionPlans){
    const restored=(await query(`SELECT ${PLAN_COLUMNS} FROM plans WHERE code=$1`,[expected.code])).rows[0];
    assert.deepStrictEqual(expectedShape(restored),expectedShape(expected),`${expected.code} modular fields did not round-trip`);
  }

  console.log('Configuration transfer settings and modular plan round-trip passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
