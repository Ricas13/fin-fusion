'use strict';

const {query}=require('../db');
const stremioFoundation=require('../stremio/foundation');
const stremioRuntimeSettings=require('../stremio/runtime-settings');
const planExternalSources=require('../stremio/plan-external-sources');

function serviceType(plan){const value=String(plan?.service_type||plan?.service_type_snapshot||'jellyfin').toLowerCase();return['jellyfin','stremio','bundle'].includes(value)?value:'jellyfin';}
function catalogueState(plan,now=Date.now()){if(plan?.archived_at)return{key:'archived',label:'Archived',kind:'bad',sellable:false};if(plan?.effective_from&&new Date(plan.effective_from).getTime()>now)return{key:'scheduled',label:'Scheduled',kind:'warn',sellable:false};if(plan?.effective_until&&new Date(plan.effective_until).getTime()<=now)return{key:'ended',label:'Ended',kind:'bad',sellable:false};if(!plan?.active)return{key:'inactive',label:'Inactive',kind:'warn',sellable:false};if(!plan?.visible)return{key:'hidden',label:'Hidden',kind:'warn',sellable:false};return{key:'catalogue_ready',label:'Catalogue ready',kind:'good',sellable:true};}
async function stremioContext(){
  await stremioRuntimeSettings.ensureLoaded();
  const [checks,planSourceStates]=await Promise.all([
    stremioRuntimeSettings.prerequisites(),
    planExternalSources.statesForAllPlans()
  ]);
  return{
    runtimeReady:stremioFoundation.runtimeReady(),
    eligibleSources:checks.eligibleSources,
    eligibleServers:checks.eligibleSources,
    eligibleManagedServers:checks.eligibleServers,
    externalSources:checks.externalSources,
    externalReadyIndexes:checks.externalReadyIndexes,
    managedServers:checks.managedServers,
    managedReadyIndexes:checks.managedReadyIndexes,
    managedKeyConfigured:checks.managedKeyConfigured,
    sourceKeyConfigured:checks.sourceKeyConfigured,
    readyIndexes:checks.readyIndexes,
    planSourceStates
  };
}
async function context(){return{stremio:await stremioContext()};}
function managedPlanReady(ctx){return Number(ctx?.stremio?.eligibleManagedServers||0)>0&&Number(ctx?.stremio?.managedReadyIndexes||0)>0;}
function contextualPlanSourceState(plan,ctx){const states=ctx?.stremio?.planSourceStates,id=String(plan?.id||plan?.plan_id||'');if(!states||!id)return null;return states[id]||{selected:0,ready:0};}
function evaluate(plan,ctx){const catalogue=catalogueState(plan);if(!catalogue.sellable)return{...catalogue,serviceType:serviceType(plan)};const delivery=serviceType(plan);if(delivery==='stremio'||delivery==='bundle'){if(!ctx?.stremio?.runtimeReady)return{key:'runtime_unavailable',label:'Runtime unavailable',kind:'bad',sellable:false,serviceType:delivery};if(Number(ctx?.stremio?.eligibleSources??ctx?.stremio?.eligibleServers??0)<1)return{key:'no_delivery_source',label:'No Stremio source',kind:'bad',sellable:false,serviceType:delivery};if(Number(ctx?.stremio?.readyIndexes||0)<1)return{key:'index_not_ready',label:'Index not ready',kind:'warn',sellable:false,serviceType:delivery};const sourceState=contextualPlanSourceState(plan,ctx);if(sourceState){const managedReady=managedPlanReady(ctx),externalReady=Number(sourceState.ready||0)>0;if(!managedReady&&!externalReady){const label=Number(sourceState.selected||0)>0?'Selected external Stremio sources unavailable':'No ready managed or selected external Stremio source';return{key:'plan_sources_unavailable',label,kind:'bad',sellable:false,serviceType:delivery,sourceState,managedReady,externalReady};}return{key:'live',label:'Live',kind:'good',sellable:true,serviceType:delivery,sourceState,managedReady,externalReady};}}return{key:'live',label:'Live',kind:'good',sellable:true,serviceType:delivery};}
async function planSourceState(planId){
  const state=await planExternalSources.stateForPlan(planId);
  return{mapped:state.selected,selected:state.selected,ready:state.ready};
}
async function evaluatePlan(plan,ctx=null){
  const resolved=ctx||await context(),base=evaluate(plan,resolved);
  if(!base.sellable||!['stremio','bundle'].includes(serviceType(plan)))return base;
  const id=plan?.id||plan?.plan_id,contextState=contextualPlanSourceState(plan,resolved),sourceState=contextState?{mapped:contextState.selected,selected:contextState.selected,ready:contextState.ready}:await planSourceState(id),managedReady=managedPlanReady(resolved),externalReady=sourceState.ready>0;
  if(!managedReady&&!externalReady){
    if(sourceState.selected>0)return{key:'plan_sources_unavailable',label:'Selected external Stremio sources unavailable',kind:'bad',sellable:false,serviceType:serviceType(plan),sourceState,managedReady,externalReady};
    return{key:'plan_sources_unavailable',label:'No ready managed or selected external Stremio source',kind:'bad',sellable:false,serviceType:serviceType(plan),sourceState,managedReady,externalReady};
  }
  return{...base,sourceState,managedReady,externalReady};
}
async function planByCode(code){const value=String(code||'').trim();if(!value)return null;const result=await query('SELECT * FROM plans WHERE code=$1 LIMIT 1',[value]);return result.rows[0]||null;}
async function assertSellablePlan(plan,ctx=null){if(!plan){const error=new Error('This plan is not available for new sale.');error.expose=true;error.status=409;throw error;}const readiness=await evaluatePlan(plan,ctx);if(!readiness.sellable){const error=new Error(`This plan cannot be sold right now: ${readiness.label}.`);error.code=`PLAN_${String(readiness.key||'UNAVAILABLE').toUpperCase()}`;error.readiness=readiness;error.expose=true;error.status=409;throw error;}return readiness;}
async function assertSellableCode(code,ctx=null){const plan=await planByCode(code),readiness=await assertSellablePlan(plan,ctx);return{plan,readiness};}
function deliveryLabel(plan){return({jellyfin:'Jellyfin',stremio:'Stremio',bundle:'Jellyfin + Stremio'})[serviceType(plan)];}
module.exports={serviceType,catalogueState,stremioContext,context,evaluate,planSourceState,managedPlanReady,contextualPlanSourceState,evaluatePlan,planByCode,assertSellablePlan,assertSellableCode,deliveryLabel};
