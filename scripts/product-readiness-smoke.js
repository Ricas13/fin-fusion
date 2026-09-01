'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const readiness=require('../src/platform/product-readiness');

const base={id:'11111111-1111-4111-8111-111111111111',active:true,visible:true,archived_at:null,effective_from:null,effective_until:null,service_type:'jellyfin'};
const good={stremio:{runtimeReady:true,eligibleSources:1,readyIndexes:1}};
const noRuntime={stremio:{runtimeReady:false,eligibleSources:1,readyIndexes:1}};
const noSource={stremio:{runtimeReady:true,eligibleSources:0,readyIndexes:0}};
const noIndex={stremio:{runtimeReady:true,eligibleSources:1,readyIndexes:0}};

assert.equal(readiness.evaluate(base,good).key,'live');
assert.equal(readiness.evaluate({...base,visible:false},good).key,'hidden');
assert.equal(readiness.evaluate({...base,active:false},good).key,'inactive');
assert.equal(readiness.evaluate({...base,archived_at:new Date()},good).key,'archived');
assert.equal(readiness.evaluate({...base,service_type:'stremio'},noRuntime).key,'runtime_unavailable');
assert.equal(readiness.evaluate({...base,service_type:'stremio'},noSource).key,'no_delivery_source');
assert.equal(readiness.evaluate({...base,service_type:'bundle'},noIndex).key,'index_not_ready');
assert.equal(readiness.evaluate({...base,service_type:'bundle'},good).key,'live');
assert.equal(readiness.deliveryLabel({service_type:'bundle'}),'Jellyfin + Stremio');

const planScopedUnavailable={stremio:{runtimeReady:true,eligibleSources:2,readyIndexes:2,eligibleManagedServers:0,managedReadyIndexes:0,planSourceStates:{[base.id]:{selected:1,ready:0}}}};
const planScopedReady={stremio:{runtimeReady:true,eligibleSources:2,readyIndexes:2,eligibleManagedServers:0,managedReadyIndexes:0,planSourceStates:{[base.id]:{selected:1,ready:1}}}};
const managedFallback={stremio:{runtimeReady:true,eligibleSources:2,readyIndexes:2,eligibleManagedServers:1,managedReadyIndexes:1,planSourceStates:{[base.id]:{selected:1,ready:0}}}};
assert.equal(readiness.evaluate({...base,service_type:'stremio'},planScopedUnavailable).key,'plan_sources_unavailable','global Stremio health must not make an unready selected source sellable');
assert.equal(readiness.evaluate({...base,service_type:'stremio'},planScopedReady).key,'live','a ready selected external source should make the plan sellable');
assert.equal(readiness.evaluate({...base,service_type:'bundle'},managedFallback).key,'live','a ready managed source may satisfy a bundle even when its selected external source is unavailable');

const root=path.join(__dirname,'..');
const pricingSource=fs.readFileSync(path.join(root,'src','payments','provider-plan-pricing.js'),'utf8');
const sourceMapSource=fs.readFileSync(path.join(root,'src','stremio','plan-external-sources.js'),'utf8');
assert(pricingSource.includes('await assertSaleReady(planCode);'),'new provider checkout lookup must enforce strict plan readiness before returning a payable mapping');
assert(pricingSource.includes('getProviderPlanByExternalId'),'historical provider identity lookup must remain separate from new-sale readiness checks');
assert(sourceMapSource.includes('async function statesForAllPlans()'),'storefront readiness context must load selected-source state for each Stremio/bundle plan');

console.log('product readiness smoke: ok');
