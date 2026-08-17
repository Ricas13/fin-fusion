'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const transfer=require('../src/platform/configuration-transfer');
const {query,getPool}=require('../src/db');

async function main(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
 const suffix=crypto.randomBytes(4).toString('hex'),code=`transfer-${suffix}`;
 const tier=(await query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,capacity_limit,streams,server_class,placement_strategy,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names) VALUES($1,$2,'portable reseller',1200,'GBP',8,2,42,TRUE,TRUE,25,5,'premium','least_users',TRUE,FALSE,TRUE,TRUE,FALSE,FALSE,TRUE,FALSE,'include',ARRAY['Movies 1080p','TV 1080p']) RETURNING id`,[code,`Transfer ${suffix}`])).rows[0];
 const gbp=(await query(`INSERT INTO reseller_tier_prices(tier_id,currency,price_minor,active,is_default) VALUES($1,'GBP',1200,TRUE,TRUE) RETURNING id`,[tier.id])).rows[0];
 const usd=(await query(`INSERT INTO reseller_tier_prices(tier_id,currency,price_minor,active,is_default) VALUES($1,'USD',1500,TRUE,FALSE) RETURNING id`,[tier.id])).rows[0];
 await query(`INSERT INTO reseller_tier_provider_prices(tier_id,tier_price_id,provider,external_id,active,verification_status) VALUES($1,$2,'stripe',$3,TRUE,'verified'),($1,$4,'paypal',$5,TRUE,'verified')`,[tier.id,gbp.id,`price_gbp_${suffix}`,usd.id,`P-USD-${suffix}`]);
 await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('jellyfin_drift_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,[JSON.stringify({healthyMinutes:360,driftMinutes:60,failureBaseMinutes:15,failureMaxMinutes:360,batchSize:100})]);

 const exported=await transfer.exportPortableConfiguration();
 assert.strictEqual(exported.version,2,'portable export must use v2');
 const portable=(exported.configuration.resellerTiers||[]).find(t=>t.code===code);
 assert(portable,'seeded reseller tier must be exported');
 assert.strictEqual(portable.server_class,'premium');
 assert.strictEqual(Number(portable.streams),5);
 assert.deepStrictEqual(portable.library_names,['Movies 1080p','TV 1080p']);
 assert(!Object.prototype.hasOwnProperty.call(portable,'credit_cost'),'reseller credit fields must not be exported');
 assert(!Object.prototype.hasOwnProperty.call(portable,'trial_credit_cost'),'reseller trial-credit fields must not be exported');
 const prices=[...(portable.prices||[])].sort((a,b)=>a.currency.localeCompare(b.currency));
 assert.strictEqual(prices.length,2,'both reseller currencies must be exported');
 assert.strictEqual(prices[0].currency,'GBP');assert.strictEqual(Number(prices[0].price_minor),1200);assert.strictEqual(prices[0].is_default,true);
 assert.strictEqual(prices[1].currency,'USD');assert.strictEqual(Number(prices[1].price_minor),1500);
 assert.deepStrictEqual(prices[0].providerMappings.map(x=>[x.provider,x.externalId]),[['stripe',`price_gbp_${suffix}`]],'GBP Stripe mapping must stay attached to GBP');
 assert.deepStrictEqual(prices[1].providerMappings.map(x=>[x.provider,x.externalId]),[['paypal',`P-USD-${suffix}`]],'USD PayPal mapping must stay attached to USD');

 const preview=await transfer.previewImport(exported);
 assert(preview.digest,'preview must produce a digest');
 assert(Number(preview.summary.providerMappingsPendingVerification)>=2,'preview must flag imported mappings for re-verification');
 assert((preview.warnings||[]).some(x=>/verification/i.test(x)),'preview must warn that imported mappings require verification');

 await query(`DELETE FROM reseller_tier_provider_prices WHERE tier_id=$1`,[tier.id]);
 await query(`DELETE FROM reseller_tier_prices WHERE tier_id=$1`,[tier.id]);
 await query(`DELETE FROM reseller_tiers WHERE id=$1`,[tier.id]);
 const result=await transfer.applyImport(exported,null);
 assert.strictEqual(result.summary.atomic,true,'import must be atomic');
 const restored=(await query(`SELECT * FROM reseller_tiers WHERE code=$1`,[code])).rows[0];
 assert(restored,'reseller tier must be restored');
 assert.strictEqual(Number(restored.streams),5);assert.strictEqual(restored.library_access_mode,'include');
 const restoredPrices=(await query(`SELECT id,currency,price_minor,is_default,active FROM reseller_tier_prices WHERE tier_id=$1 ORDER BY currency`,[restored.id])).rows;
 assert.strictEqual(restoredPrices.length,2);assert.strictEqual(String(restoredPrices[0].currency).trim(),'GBP');assert.strictEqual(Number(restoredPrices[0].price_minor),1200);assert.strictEqual(restoredPrices[0].is_default,true);assert.strictEqual(String(restoredPrices[1].currency).trim(),'USD');assert.strictEqual(Number(restoredPrices[1].price_minor),1500);
 const restoredMappings=(await query(`SELECT pp.provider,pp.external_id,pp.active,pp.verification_status,pr.currency FROM reseller_tier_provider_prices pp JOIN reseller_tier_prices pr ON pr.id=pp.tier_price_id WHERE pp.tier_id=$1 ORDER BY pr.currency,pp.provider`,[restored.id])).rows;
 assert.deepStrictEqual(restoredMappings.map(x=>[String(x.currency).trim(),x.provider,x.external_id]),[['GBP','stripe',`price_gbp_${suffix}`],['USD','paypal',`P-USD-${suffix}`]],'provider mappings must not cross currencies during import');
 assert(restoredMappings.every(x=>x.active===false),'imported provider mappings must remain inactive until verified');
 assert(restoredMappings.every(x=>x.verification_status==='unverified'),'imported provider mappings must require verification');

 // Legacy single-price reseller backups still normalize to one default price.
 const legacy=JSON.parse(JSON.stringify(exported));
 const legacyTier=legacy.configuration.resellerTiers.find(t=>t.code===code);delete legacyTier.prices;legacyTier.providerMappings=[{provider:'stripe',externalId:`legacy_${suffix}`,active:true}];legacyTier.monthly_price_minor=999;legacyTier.currency='EUR';
 const parsedLegacy=transfer.parseDocument(legacy),normalized=parsedLegacy.configuration.resellerTiers.find(t=>t.code===code);
 assert.strictEqual(normalized.prices.length,1);assert.strictEqual(normalized.prices[0].currency,'EUR');assert.strictEqual(Number(normalized.prices[0].price_minor),999);assert.strictEqual(normalized.prices[0].providerMappings[0].externalId,`legacy_${suffix}`);

 console.log('Configuration transfer multicurrency reseller round-trip passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>getPool().end());
