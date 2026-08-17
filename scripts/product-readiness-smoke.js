'use strict';

const assert=require('assert');
const readiness=require('../src/platform/product-readiness');

const base={active:true,visible:true,archived_at:null,effective_from:null,effective_until:null,service_type:'jellyfin'};
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

console.log('product readiness smoke: ok');
