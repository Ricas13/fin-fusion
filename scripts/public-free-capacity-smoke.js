'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const publicFree=require('../src/entitlements/public-free-capacity');

const freePlan={id:'free',is_free_tier:true,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0};
const makeState=remaining=>({plan:freePlan,planId:'free',model:'fleet_users',remaining,soldOut:remaining===0,limit:50,used:50-remaining,reserved:0,pool:'free'});
const available=rows=>async()=>rows;
const decorate=async rows=>rows;
const model=remaining=>async()=>makeState(remaining);
const mockDb=async()=>{throw Error('Unexpected real DB access');};
async function check(a,servers,want){
 const result=await publicFree.usage('free',mockDb,{modelUsage:model(a),eligibleServers:available(servers),decorateServers:decorate});
 assert.equal(result.remaining,want);
 assert.equal(result.soldOut,want===0);
 assert.equal(result.modelARemaining,a);
 return result;
}
(async()=>{
 // The critical false-positive: A sees the last slot, B counts a durable
 // in-flight creation intent and correctly marks the physical server full.
 await check(1,[{max_users:50,capacity_users:50}],0);
 await check(3,[{max_users:50,capacity_users:49}],1);
 await check(0,[{max_users:50,capacity_users:47}],0);
 await check(3,[],0);
 // Model A ignores NULL, and interprets 0 capacity as zero. Do not copy
 // Model B's 'NULL/0 means unlimited' convention into public announcements.
 await check(2,[{max_users:null,capacity_users:0},{max_users:0,capacity_users:0}],0);
 await check(2,[{max_users:null,capacity_users:0},{max_users:4,capacity_users:3}],1);
 // Only Free fleet plans are changed. Paid/other enforcement retains Model A.
 let eligibilityCalled=false;
 const paid=await publicFree.usage('paid',mockDb,{
   modelUsage:async()=>({...makeState(3),plan:{...freePlan,is_free_tier:false}}),
   eligibleServers:async()=>{eligibilityCalled=true;return [];},decorateServers:decorate
 });
 assert.equal(paid.remaining,3);
 assert.equal(eligibilityCalled,false);
 // Query failures must not silently advertise 'available'.
 await assert.rejects(publicFree.usage('free',mockDb,{
   modelUsage:model(2),eligibleServers:async()=>{throw Error('DB unavailable');},decorateServers:decorate
 }),/DB unavailable/);
 const source=(name)=>fs.readFileSync(path.resolve(__dirname,'..',name),'utf8');
 assert.match(source('src/security/pending-registration.js'),/publicFreeCapacity\.usage\(plan\.id,/);
 assert.match(source('src/security/pending-registration.js'),/planCapacity\.lockAndAssert\(client,freePlan\.id/);
 assert.match(source('src/payments/lifecycle.js'),/excludeReservationId:reservationId/);
 assert.match(source('src/automation/free-places-digest.js'),/entitlements\/public-free-capacity/);
 assert.match(source('src/platform/storefront.js'),/entitlements\/public-free-capacity/);
 assert.match(source('src/platform/storefront.js'),/Temporarily unavailable/);
 console.log('public Free capacity divergence smoke: ok');
})().catch(error=>{console.error(error);process.exitCode=1;});
