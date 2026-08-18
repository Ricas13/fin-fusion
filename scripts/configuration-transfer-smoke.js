'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const transfer=require('../src/platform/configuration-transfer');
const {query,getPool}=require('../src/db');

async function main(){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const suffix=crypto.randomBytes(4).toString('hex'),code=`portable-reseller-${suffix}`;

  const tier=(await query(`INSERT INTO reseller_tiers(
      code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,
      capacity_limit,server_class,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,
      allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,
      library_access_mode,library_names,placement_strategy
    ) VALUES($1,$2,'portable monthly reseller catalogue',4000,'GBP',5,3,42,TRUE,TRUE,7,'premium',4,TRUE,FALSE,TRUE,TRUE,FALSE,FALSE,TRUE,FALSE,'include',$3::text[],'least_streams') RETURNING id`,
    [code,`Portable reseller ${suffix}`,['Movies 1080p','TV 1080p']])).rows[0];

  await query(`INSERT INTO reseller_tier_prices(tier_id,currency,price_minor,active,is_default) VALUES($1,'GBP',4000,TRUE,TRUE),($1,'USD',5200,TRUE,FALSE)`,[tier.id]);

  const resellerDefaults={defaultGraceDays:3,defaultServerClass:'premium'};
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('reseller_defaults_v2',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(resellerDefaults)]);
  const expectedAffiliate={enabled:true,rewardPercent:22,qualificationDelayDays:9,refundWindowDays:14};
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify(expectedAffiliate)]);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('jellyfin_drift_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify({healthyMinutes:360,driftMinutes:60,failureBaseMinutes:15,failureMaxMinutes:360,batchSize:100})]);

  const exported=await transfer.exportPortableConfiguration();
  assert.strictEqual(exported.version,2,'portable export must use v2');
  const exportedTier=exported.configuration.resellerTiers.find(item=>item.code===code);
  assert(exportedTier,'live monthly reseller tier must be exported');
  assert.strictEqual(exportedTier.capacity_limit,7,'reseller subscription capacity must be portable');
  assert.strictEqual(exportedTier.server_class,'premium','reseller server class must be portable');
  assert.strictEqual(exportedTier.streams,4,'reseller per-user stream policy must be portable');
  assert.strictEqual(exportedTier.allow_downloads,true,'reseller download policy must be portable');
  assert.strictEqual(exportedTier.allow_video_transcoding,false,'reseller transcode policy must be portable');
  assert.strictEqual(exportedTier.library_access_mode,'include','reseller library mode must be portable');
  assert.deepStrictEqual(exportedTier.library_names,['Movies 1080p','TV 1080p'],'reseller library names must be portable');
  assert.strictEqual(exportedTier.placement_strategy,'least_streams','reseller placement strategy must be portable');
  assert.deepStrictEqual(exportedTier.prices.map(p=>[p.currency,p.price_minor,p.is_default]),[['GBP',4000,true],['USD',5200,false]],'multi-currency reseller prices must be portable');
  assert.deepStrictEqual(exported.configuration.settings.reseller_defaults_v2,resellerDefaults,'live reseller defaults must be portable');
  assert(!Object.prototype.hasOwnProperty.call(exported.configuration.settings,'reseller_defaults'),'retired credit-era reseller defaults must not be exported');
  assert.deepStrictEqual(exported.configuration.settings.affiliate_program,expectedAffiliate,'affiliate programme settings must be portable');
  for(const plan of exported.configuration.plans||[]){
    assert(!Object.prototype.hasOwnProperty.call(plan,'reseller_credit_cost'),'retired reseller credit fields must not be exported');
    assert(!Object.prototype.hasOwnProperty.call(plan,'reseller_trial_credit_cost'),'retired reseller trial-credit fields must not be exported');
  }

  const preview=await transfer.previewImport(exported);
  assert(preview.digest,'preview must produce a digest');
  assert(Number(preview.summary.resellerTiersUpdate||0)>=1,'preview must recognize the existing live reseller tier as an update');
  assert.strictEqual(Number(preview.summary.affiliateProgram||0),1,'preview must recognize affiliate settings');

  // Damage the local values so applyImport proves the reseller catalogue is
  // actually restored, rather than merely serialized in the export.
  await query(`UPDATE reseller_tiers SET capacity_limit=1,streams=1,allow_downloads=FALSE,allow_video_transcoding=TRUE,library_access_mode='all',library_names='{}'::text[],placement_strategy='least_users' WHERE id=$1`,[tier.id]);
  await query(`UPDATE reseller_tier_prices SET price_minor=1 WHERE tier_id=$1`,[tier.id]);
  await query(`UPDATE platform_settings SET setting_value=$2::jsonb WHERE setting_key=$1`,['affiliate_program',JSON.stringify({enabled:false,rewardPercent:1,qualificationDelayDays:0,refundWindowDays:0})]);
  await query(`UPDATE platform_settings SET setting_value='{}'::jsonb WHERE setting_key='reseller_defaults_v2'`);

  const result=await transfer.applyImport(exported,null);
  assert.strictEqual(result.summary.atomic,true,'configuration import must remain atomic');

  const restoredTier=(await query(`SELECT capacity_limit,server_class,streams,allow_downloads,allow_video_transcoding,library_access_mode,library_names,placement_strategy FROM reseller_tiers WHERE id=$1`,[tier.id])).rows[0];
  assert.strictEqual(Number(restoredTier.capacity_limit),7,'reseller capacity did not round-trip');
  assert.strictEqual(restoredTier.server_class,'premium','reseller server class did not round-trip');
  assert.strictEqual(Number(restoredTier.streams),4,'reseller stream policy did not round-trip');
  assert.strictEqual(restoredTier.allow_downloads,true,'reseller download policy did not round-trip');
  assert.strictEqual(restoredTier.allow_video_transcoding,false,'reseller video transcode policy did not round-trip');
  assert.strictEqual(restoredTier.library_access_mode,'include','reseller library mode did not round-trip');
  assert.deepStrictEqual(restoredTier.library_names,['Movies 1080p','TV 1080p'],'reseller library names did not round-trip');
  assert.strictEqual(restoredTier.placement_strategy,'least_streams','reseller placement strategy did not round-trip');

  const restoredPrices=(await query(`SELECT currency,price_minor,is_default,active FROM reseller_tier_prices WHERE tier_id=$1 ORDER BY is_default DESC,currency`,[tier.id])).rows;
  assert.deepStrictEqual(restoredPrices.map(p=>[String(p.currency).trim(),Number(p.price_minor),p.is_default,p.active]),[['GBP',4000,true,true],['USD',5200,false,true]],'reseller multi-currency prices did not round-trip');

  const restoredAffiliate=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredAffiliate,expectedAffiliate,'affiliate programme settings did not round-trip');
  const restoredDefaults=(await query(`SELECT setting_value FROM platform_settings WHERE setting_key='reseller_defaults_v2'`)).rows[0]?.setting_value;
  assert.deepStrictEqual(restoredDefaults,resellerDefaults,'live reseller defaults did not round-trip');

  console.log('Configuration transfer monthly reseller catalogue round-trip passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
