'use strict';

const assert=require('assert');
const path=require('path');
const externalDeletion=require('../src/platform/customer-external-deletion');

function target(provider,id='resource-1'){
  return{id:`${provider}-${id}`,deletion_job_id:'job-1',customer_id:'customer-1',provider,resource_type:provider==='request_service'?'permissions':provider==='discord'?'managed_role':provider==='stremio'?'install_credential':'user',external_identifier:id,desired_state:'absent',state:'pending',blocking:true,attempt_count:0,next_attempt_at:new Date(),last_error:null,metadata:{identity:id},result:null};
}
function storeFor(rows){return new Map(rows.map(row=>[row.id,{...row,metadata:{...row.metadata}}]));}
function snapshot(store){return [...store.values()].map(row=>({...row,metadata:{...row.metadata},result:row.result&&{...row.result}}));}

async function run(store,execute,{failCompletionOnceFor=null}={}){
  let completionFailed=false;
  return externalDeletion.runTargetStateMachine(snapshot(store),{
    claim:async original=>{const row=store.get(original.id);if(row.state==='succeeded')return{...row};row.state='running';row.attempt_count+=1;row.last_error=null;return{...row};},
    execute,
    complete:async(row,result)=>{if(failCompletionOnceFor===row.id&&!completionFailed){completionFailed=true;throw new Error('simulated completion write failure');}const current=store.get(row.id);current.state='succeeded';current.result=result;current.last_error=null;current.completed_at=new Date();},
    fail:async(row,error)=>{const current=store.get(row.id);current.state='failed';current.last_error=String(error.message||error);current.next_attempt_at=new Date(Date.now()+externalDeletion.retryMinutes(current.attempt_count)*60000);}
  });
}

async function scenarioA(){
  const rows=[target('jellyfin','jf-user'),target('request_service','request-user'),target('discord','discord-role'),target('stremio','install-token')],store=storeFor(rows),remote=new Map(rows.map(row=>[row.id,true]));
  await run(store,async row=>{remote.set(row.id,false);return{status:'absent'};});
  assert(snapshot(store).every(row=>row.state==='succeeded'),'A: every external target should succeed');
  assert([...remote.values()].every(value=>value===false),'A: every simulated managed access resource should be absent');
}
async function scenarioB(){
  const row=target('request_service','request-user'),store=storeFor([row]);let calls=0;
  await run(store,async()=>{calls++;if(calls===1)throw new Error('request service unavailable');return{status:'permissions_revoked',permissions:0};});
  assert.strictEqual(store.get(row.id).state,'failed','B: unavailable request service must remain failed/pending');
  assert.match(store.get(row.id).last_error,/unavailable/,'B: request failure must be operator-visible');
  await run(store,async()=>({status:'permissions_revoked',permissions:0}));
  assert.strictEqual(store.get(row.id).state,'succeeded','B: retry should converge');
}
async function scenarioC(){
  const row=target('discord','user:role'),store=storeFor([row]);let calls=0,customerIdentityPresent=true;
  await run(store,async()=>{calls++;if(calls===1)throw new Error('Discord HTTP 503');return{status:'removed'};});
  if(externalDeletion.targetSummary(snapshot(store)).blocking.length===0)customerIdentityPresent=false;
  assert.strictEqual(customerIdentityPresent,true,'C: canonical identity must remain while Discord blocks');
  assert.strictEqual(store.get(row.id).external_identifier,'user:role','C: durable Discord identity must survive failure');
  await run(store,async()=>({status:'removed'}));
  if(externalDeletion.targetSummary(snapshot(store)).blocking.length===0)customerIdentityPresent=false;
  assert.strictEqual(customerIdentityPresent,false,'C: finalization may proceed after Discord removal');
}
async function scenarioD(){
  const persisted=storeFor([target('jellyfin','jf-user')]);
  // Crash after persistence: no API call and no state mutation. A new worker
  // instance receives the same durable rows and continues normally.
  const restarted=persisted;
  await run(restarted,async()=>({status:'deleted'}));
  assert.strictEqual(restarted.values().next().value.state,'succeeded','D: restart after persistence must converge');
}
async function scenarioE(){
  const row=target('jellyfin','jf-user'),store=storeFor([row]);let remoteExists=true,calls=0;
  await run(store,async()=>{calls++;if(remoteExists){remoteExists=false;return{status:'deleted'};}return{status:'already_missing'};},{failCompletionOnceFor:row.id});
  assert.strictEqual(remoteExists,false,'E: external API side effect happened');
  assert.strictEqual(store.get(row.id).state,'failed','E: failed completion write must not be falsely succeeded');
  await run(store,async()=>{calls++;return{status:'already_missing'};});
  assert.strictEqual(store.get(row.id).state,'succeeded','E: idempotent retry must recover after lost completion write');
  assert(calls>=2,'E: cleanup should be safely rechecked/retried');
}
async function scenarioF(){
  const dbPath=require.resolve('../src/db'),registryPath=require.resolve('../src/jellyfin/registry'),provisioningPath=require.resolve('../src/jellyfin/provisioning'),externalPath=require.resolve('../src/platform/customer-external-deletion'),deletionPath=require.resolve('../src/platform/customer-deletion');
  const saved=new Map([dbPath,registryPath,provisioningPath,externalPath,deletionPath].map(key=>[key,require.cache[key]]));
  const succeeded={id:'job-succeeded',customer_id:'customer-gone',status:'succeeded',result:{deleted:true,jobId:'job-succeeded'}};let queries=0;
  try{
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{query:async sql=>{queries++;if(String(sql).includes('FROM customer_deletion_jobs WHERE customer_id'))return{rowCount:1,rows:[succeeded]};throw new Error('duplicate deletion should reuse tombstone before reading deleted customer');}}};
    require.cache[registryPath]={id:registryPath,filename:registryPath,loaded:true,exports:{}};
    require.cache[provisioningPath]={id:provisioningPath,filename:provisioningPath,loaded:true,exports:{}};
    require.cache[externalPath]={id:externalPath,filename:externalPath,loaded:true,exports:{deletionStatus:async()=>null}};
    delete require.cache[deletionPath];
    const deletion=require('../src/platform/customer-deletion');
    const replay=await deletion.enqueueHardDelete('customer-gone');
    assert.strictEqual(replay.id,'job-succeeded','F: duplicate request after deletion should reuse durable succeeded job');
    assert.strictEqual(queries,1,'F: duplicate replay must not require the deleted customer row');
  }finally{
    for(const [key,value] of saved){if(value)require.cache[key]=value;else delete require.cache[key];}
  }
}
async function scenarioG(){
  const row=target('jellyfin','already-gone'),store=storeFor([row]);
  await run(store,async()=>({status:'already_missing'}));
  assert.strictEqual(store.get(row.id).state,'succeeded','G: already-missing resource is converged success');
}
async function scenarioH(){
  const row=target('discord','permanent-failure'),store=storeFor([row]);
  await run(store,async()=>{throw new Error('missing Manage Roles permission');});
  const summary=externalDeletion.targetSummary(snapshot(store));
  assert.strictEqual(summary.blocking.length,1,'H: permanent provider failure must remain blocking');
  assert.strictEqual(summary.blocking[0].provider,'discord','H: operator state identifies provider');
  assert.strictEqual(summary.blocking[0].externalIdentifier,'permanent-failure','H: operator state identifies resource');
  assert.match(summary.blocking[0].lastError,/Manage Roles/,'H: operator state exposes exact error');
  assert.strictEqual(summary.blocking[0].attempts,1,'H: attempts are durable/visible');
}
async function scenarioI(){
  const row=target('request_service','restart-midway'),durable=storeFor([row]);let first=true;
  await run(durable,async()=>{if(first){first=false;throw new Error('worker interrupted');}return{status:'permissions_revoked',permissions:0};});
  assert.strictEqual(durable.get(row.id).state,'failed','I: interrupted worker leaves durable retry state');
  // New runner/process, same durable store.
  await run(durable,async()=>({status:'permissions_revoked',permissions:0}));
  assert.strictEqual(durable.get(row.id).state,'succeeded','I: restarted worker completes midway deletion');
}

async function scenarioJ(){
  const requestUserSyncPath=require.resolve('../src/integrations/request-user-sync'),externalPath=require.resolve('../src/platform/customer-external-deletion');
  const saved=new Map([requestUserSyncPath,externalPath].map(key=>[key,require.cache[key]]));
  try{
    require.cache[requestUserSyncPath]={id:requestUserSyncPath,filename:requestUserSyncPath,loaded:true,exports:{externalUsers:async()=>[{id:999,email:'someone-else@example.com',username:'someone-else'}],permissionState:async()=>0,setPermissions:async()=>{}}};
    delete require.cache[externalPath];
    const fresh=require('../src/platform/customer-external-deletion');

    const everProvisioned={id:'request_service-1',provider:'request_service',resource_type:'permissions',external_identifier:'identity:stale@example.com',metadata:{externalUserId:null,email:'stale@example.com',username:'stale',everProvisioned:true}};
    await assert.rejects(fresh.executeTarget(everProvisioned),/could not be located/,'J: a previously-provisioned request-service account that cannot be matched must escalate, not silently succeed');

    const neverProvisioned={id:'request_service-2',provider:'request_service',resource_type:'permissions',external_identifier:'identity:new@example.com',metadata:{externalUserId:null,email:'new@example.com',username:'new',everProvisioned:false}};
    const result=await fresh.executeTarget(neverProvisioned);
    assert.strictEqual(result.status,'already_missing','J: an account never provisioned on the request service is safely already-missing');
  }finally{
    for(const [key,value] of saved){if(value)require.cache[key]=value;else delete require.cache[key];}
  }
}

(async()=>{
  await scenarioA();await scenarioB();await scenarioC();await scenarioD();await scenarioE();await scenarioF();await scenarioG();await scenarioH();await scenarioI();await scenarioJ();
  assert.strictEqual(externalDeletion.retryMinutes(1),1);
  assert.strictEqual(externalDeletion.retryMinutes(99),360,'retry backoff must be bounded');
  console.log('customer deletion durable target runtime smoke passed (A-J)');
})().catch(error=>{console.error(error);process.exit(1);});
