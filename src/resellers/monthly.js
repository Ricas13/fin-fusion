'use strict';

const core=require('./monthly-core');
const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/provisioning');
const accessHolds=require('../entitlements/access-holds');
const tierPricing=require('../payments/reseller-tier-pricing');

const ESTATE_HOLD='reseller_subscription';
function entitled(row){if(!row)return false;const now=Date.now();if(row.status==='active'&&new Date(row.current_period_end).getTime()>now)return true;if(row.status==='past_due'&&row.grace_until&&new Date(row.grace_until).getTime()>now)return true;if(row.manual_grace_until&&new Date(row.manual_grace_until).getTime()>now)return true;return false}

async function listTiers({visibleOnly=false,activeOnly=false,currency=null,allowFallback=true}={}){
  const clauses=[];if(visibleOnly)clauses.push('t.visible=TRUE');if(activeOnly)clauses.push('t.active=TRUE');
  const result=await query(`SELECT t.* FROM reseller_tiers t ${clauses.length?`WHERE ${clauses.join(' AND ')}`:''} ORDER BY t.active DESC,t.sort_order,t.seat_limit,t.name`);
  if(currency)return tierPricing.decorateTiers(result.rows,currency,{allowFallback});
  const ids=result.rows.map(t=>t.id);if(!ids.length)return[];
  const [prices,mappings]=await Promise.all([
    query(`SELECT * FROM reseller_tier_prices WHERE tier_id=ANY($1::uuid[]) ORDER BY is_default DESC,currency`,[ids]),
    query(`SELECT * FROM reseller_tier_provider_prices WHERE tier_id=ANY($1::uuid[]) ORDER BY provider,created_at`,[ids])
  ]);
  const priceMap=new Map(),mappingMap=new Map();
  for(const row of prices.rows){const key=String(row.tier_id);if(!priceMap.has(key))priceMap.set(key,[]);priceMap.get(key).push({...row,currency:String(row.currency).trim()})}
  for(const row of mappings.rows){const key=String(row.tier_id);if(!mappingMap.has(key))mappingMap.set(key,[]);mappingMap.get(key).push(row)}
  return result.rows.map(t=>({...t,currency:String(t.currency).trim(),prices:priceMap.get(String(t.id))||[],provider_prices:mappingMap.get(String(t.id))||[]}));
}
async function tierById(tierId){const r=await query('SELECT * FROM reseller_tiers WHERE id=$1',[tierId]);return r.rows[0]||null}
async function tierByCode(code){const r=await query(`SELECT * FROM reseller_tiers WHERE code=$1 AND active=TRUE`,[String(code||'').trim()]);return r.rows[0]||null}

async function currentSubscription(resellerId,client=null){
  const db=client||{query},result=await db.query(`SELECT rs.*,rt.code AS tier_code,COALESCE(rs.tier_name_snapshot,rt.name) AS tier_name,COALESCE(rs.seat_limit_snapshot,rt.seat_limit) AS seat_limit,COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor) AS monthly_price_minor,COALESCE(rs.currency_snapshot,rt.currency) AS currency,COALESCE(rs.grace_days_snapshot,rt.grace_days,0) AS grace_days,rt.streams,rt.server_class,rt.allow_video_transcoding,rt.library_access_mode,rt.library_names FROM reseller_subscriptions rs JOIN reseller_tiers rt ON rt.id=rs.tier_id WHERE rs.reseller_id=$1 ORDER BY CASE WHEN rs.status='active' AND rs.current_period_end>NOW() THEN 0 WHEN rs.status='past_due' AND COALESCE(rs.grace_until,rs.manual_grace_until)>NOW() THEN 1 ELSE 2 END,rs.current_period_end DESC,rs.created_at DESC LIMIT 1`,[resellerId]);
  return result.rows[0]||null;
}
async function resellerEntitlement(resellerId,client=null){const row=await currentSubscription(resellerId,client);return{row,active:entitled(row),inGrace:Boolean(row&&row.status==='past_due'&&((row.grace_until&&new Date(row.grace_until)>new Date())||(row.manual_grace_until&&new Date(row.manual_grace_until)>new Date())))}}
async function seatUsage(resellerId,client=null){const db=client||{query},r=await db.query(`SELECT COUNT(*)::int used FROM customers WHERE reseller_id=$1 AND reseller_managed=TRUE`,[resellerId]);return Number(r.rows[0]?.used||0)}
async function assertSeatAvailable(client,resellerId){const lock=await client.query('SELECT id FROM resellers WHERE id=$1 FOR UPDATE',[resellerId]);if(!lock.rowCount)throw new Error('Reseller not found.');const state=await resellerEntitlement(resellerId,client);if(!state.active)throw new Error('Your reseller subscription is not active. Renew it before managing Jellyfin users.');const used=await seatUsage(resellerId,client),limit=Number(state.row.seat_limit||0);if(used>=limit)throw new Error(`Your ${state.row.tier_name} plan is full (${used}/${limit} managed Jellyfin users). Delete an unused user or upgrade the reseller plan.`);return{entitlement:state.row,used,limit}}

async function estateCustomerIds(resellerId,client=null){const db=client||{query},r=await db.query(`SELECT id FROM customers WHERE reseller_id=$1 AND reseller_managed=TRUE ORDER BY id`,[resellerId]);return r.rows.map(x=>x.id)}
async function reconcileIds(ids){const results=[];for(const customerId of ids){try{await provisioning.reconcileCustomer(customerId);results.push({customerId,ok:true})}catch(error){results.push({customerId,ok:false,error:error.message})}}return results}
async function suspendEstate(resellerId,reason='Reseller subscription is not active'){
  const changed=[],ids=await transaction(async client=>{const customerIds=await estateCustomerIds(resellerId,client);for(const customerId of customerIds){const before=await client.query(`SELECT 1 FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL`,[customerId,ESTATE_HOLD,resellerId]);if(!before.rowCount){await accessHolds.addHold({customerId,type:ESTATE_HOLD,sourceKey:resellerId,reason,metadata:{resellerId}},client);changed.push(customerId)}}await client.query(`UPDATE resellers SET estate_suspended_at=COALESCE(estate_suspended_at,NOW()),estate_suspend_reason=$2 WHERE id=$1`,[resellerId,String(reason).slice(0,500)]);if(changed.length)await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('reseller.estate.suspend','reseller',$1,$2::jsonb)`,[resellerId,JSON.stringify({reason,customers:changed.length})]);return customerIds});return{customers:ids.length,changed:changed.length,reconciliation:await reconcileIds(changed)}}
async function restoreEstate(resellerId){const changed=[],ids=await transaction(async client=>{const customerIds=await estateCustomerIds(resellerId,client);for(const customerId of customerIds){const released=await accessHolds.releaseHold({customerId,type:ESTATE_HOLD,sourceKey:resellerId},client);if(released)changed.push(customerId)}await client.query(`UPDATE resellers SET estate_suspended_at=NULL,estate_suspend_reason=NULL WHERE id=$1`,[resellerId]);if(changed.length)await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('reseller.estate.restore','reseller',$1,$2::jsonb)`,[resellerId,JSON.stringify({customers:changed.length})]);return customerIds});return{customers:ids.length,changed:changed.length,reconciliation:await reconcileIds(changed)}}
async function reconcileEstate(resellerId){const state=await resellerEntitlement(resellerId);if(state.active)return restoreEstate(resellerId);const reason=state.row?`Reseller subscription ${state.row.status}; paid access ended ${new Date(state.row.current_period_end).toISOString()}`:'No active reseller subscription';return suspendEstate(resellerId,reason)}
async function reconcileAllEstates(){const r=await query('SELECT id FROM resellers ORDER BY id'),summary={total:r.rowCount,active:0,suspended:0,changed:0,failed:0};for(const row of r.rows){try{const state=await resellerEntitlement(row.id),outcome=await reconcileEstate(row.id);summary.changed+=Number(outcome.changed||0);if(state.active)summary.active++;else summary.suspended++}catch(error){summary.failed++;console.error(`Reseller estate reconcile failed for ${row.id}:`,error.message)}}return summary}

async function applyGrace(saved){if(!saved?.id)return saved;const row=await currentSubscription(saved.reseller_id);if(!row)return saved;if(row.status==='past_due'&&Number(row.grace_days||0)>0)await query(`UPDATE reseller_subscriptions SET grace_until=COALESCE(grace_until,NOW()+($2::int*INTERVAL '1 day')),updated_at=NOW() WHERE id=$1`,[row.id,Number(row.grace_days)]);else if(row.status==='active')await query('UPDATE reseller_subscriptions SET grace_until=NULL WHERE id=$1',[row.id]);await reconcileEstate(saved.reseller_id);return currentSubscription(saved.reseller_id)}
async function setProviderSubscription(input){return applyGrace(await core.setProviderSubscription(input))}
async function updateKnownProviderSubscription(input){return applyGrace(await core.updateKnownProviderSubscription(input))}
async function createManualTierSubscription(input){const row=await core.createManualTierSubscription(input);await reconcileEstate(input.resellerId);return currentSubscription(input.resellerId)||row}
async function getResellerCustomer(resellerId,customerId){const r=await query(`SELECT * FROM customers WHERE id=$1 AND reseller_id=$2 AND reseller_managed=TRUE`,[customerId,resellerId]);return r.rows[0]||null}

module.exports={
  cleanText:core.cleanText,moneyMinor:core.moneyMinor,cleanCurrency:core.cleanCurrency,randomCheckoutKey:core.randomCheckoutKey,
  listTiers,tierById,tierByCode,currentSubscription,resellerEntitlement,seatUsage,assertSeatAvailable,
  suspendEstate,restoreEstate,reconcileEstate,reconcileAllEstates,setProviderSubscription,updateKnownProviderSubscription,
  createManualTierSubscription,providerMapping:tierPricing.providerMapping,getResellerCustomer,statusIsEntitled:entitled
};
