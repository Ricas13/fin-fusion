'use strict';

const assert=require('assert');
const freePlaces=require('../src/automation/free-places-digest');

const settings={
  discordFreePlacesDigestEnabled:true,
  discordConfigured:true,
  discordFreePlacesChannelId:'123456789012345678',
  discordFreePlacesTimezone:'UTC',
  discordFreePlacesTime1:'00:00',
  discordFreePlacesTime2:'12:00',
  discordFreePlacesMinRemaining:1
};
const operationsConfig={publicBaseUrl:'https://store.example.test'};

function harness(){
  let remaining=0,stored=null,sendSequence=0,failNextSend=false,missingNextEdit=false,lockCount=0;
  const sends=[],edits=[],removes=[];
  const client={query:async(sql,params=[])=>{
    const text=String(sql);
    if(text.includes('pg_advisory_xact_lock')){lockCount++;return{rows:[]};}
    if(text.includes('SELECT id FROM plans'))return{rows:[{id:'00000000-0000-0000-0000-000000000001'}],rowCount:1};
    if(text.includes('SELECT setting_value FROM platform_settings'))return{rows:stored?[{setting_value:{...stored}}]:[],rowCount:stored?1:0};
    if(text.includes('INSERT INTO platform_settings')){
      stored=JSON.parse(params[1]);
      return{rows:[],rowCount:1};
    }
    throw new Error(`Unexpected free-places test query: ${text.slice(0,100)}`);
  }};
  const transactionFn=async fn=>fn(client);
  const usage=async()=>({remaining});
  const send=async args=>{
    sends.push(args);
    if(failNextSend){failNextSend=false;throw new Error('simulated Discord POST failure');}
    sendSequence++;
    return{id:`message-${sendSequence}`};
  };
  const edit=async args=>{
    edits.push(args);
    if(missingNextEdit){missingNextEdit=false;throw new Error('Discord HTTP 404 unknown message');}
    return{id:args.messageId};
  };
  const remove=async args=>{removes.push(args);return{};};
  const sync=now=>freePlaces.syncPersistent({settings,operationsConfig,usage,send,edit,remove,transactionFn,now:new Date(now)});
  return{
    sync,sends,edits,removes,
    setRemaining:value=>{remaining=value;},
    getStored:()=>stored&&{...stored},
    setStored:value=>{stored=value&&{...value};},
    failSend:()=>{failNextSend=true;},
    missEdit:()=>{missingNextEdit=true;},
    lockCount:()=>lockCount
  };
}

(async()=>{
  assert.strictEqual(freePlaces.advertSlotKey(settings,new Date('2026-09-18T11:59:00Z')),'2026-09-18T00:00');
  assert.strictEqual(freePlaces.advertSlotKey(settings,new Date('2026-09-18T12:00:00Z')),'2026-09-18T12:00');
  assert.strictEqual(freePlaces.advertSlotKey(settings,new Date('2026-09-19T00:00:00Z')),'2026-09-19T00:00');

  const h=harness();

  // Initial setup publishes exactly one canonical status message and establishes
  // the current advert slot. Setup is not treated as a reopening alert.
  h.setRemaining(0);
  let result=await h.sync('2026-09-18T09:00:00Z');
  assert.strictEqual(result.created,1);
  assert.strictEqual(result.availabilityRestored,0);
  assert.strictEqual(h.sends.length,1);
  assert.strictEqual(h.getStored().remaining,0);
  assert.strictEqual(h.getStored().observedRemaining,0);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-18T00:00');

  // Capacity reopens before noon. The worker observes and stores it but does not
  // edit or POST Discord yet; newly freed places accumulate silently.
  h.setRemaining(1);
  result=await h.sync('2026-09-18T09:05:00Z');
  assert.strictEqual(result.buffered,true);
  assert.strictEqual(result.remaining,0);
  assert.strictEqual(result.observedRemaining,1);
  assert.strictEqual(h.sends.length,1);
  assert.strictEqual(h.edits.length,0);

  h.setRemaining(3);
  result=await h.sync('2026-09-18T10:30:00Z');
  assert.strictEqual(result.buffered,true);
  assert.strictEqual(result.remaining,0);
  assert.strictEqual(result.observedRemaining,3);
  assert.strictEqual(h.sends.length,1);
  assert.strictEqual(h.edits.length,0);

  // At the noon slot all accumulated availability is advertised once. The old
  // canonical message is removed and one fresh Discord message is posted.
  result=await h.sync('2026-09-18T12:00:00Z');
  assert.strictEqual(result.advertised,1);
  assert.strictEqual(result.created,1);
  assert.strictEqual(result.availabilityRestored,1);
  assert.strictEqual(result.remaining,3);
  assert.strictEqual(h.removes.length,1);
  assert.strictEqual(h.sends.length,2);
  assert.strictEqual(h.edits.length,0);
  assert.strictEqual(h.getStored().messageId,'message-2');
  assert.strictEqual(h.getStored().remaining,3);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-18T12:00');

  // Filling advertised places is always quiet and edits the current message
  // downward immediately.
  h.setRemaining(2);
  result=await h.sync('2026-09-18T12:05:00Z');
  assert.strictEqual(result.created,0);
  assert.strictEqual(h.edits.length,1);
  assert.strictEqual(h.getStored().remaining,2);

  h.setRemaining(0);
  result=await h.sync('2026-09-18T13:00:00Z');
  assert.strictEqual(result.created,0);
  assert.strictEqual(h.edits.length,2);
  assert.strictEqual(h.getStored().remaining,0);

  // Reopening again after noon is buffered all the way to midnight. Multiple
  // frees do not create repeated channel posts.
  h.setRemaining(1);
  await h.sync('2026-09-18T14:00:00Z');
  h.setRemaining(2);
  await h.sync('2026-09-18T18:00:00Z');
  h.setRemaining(4);
  result=await h.sync('2026-09-18T23:59:00Z');
  assert.strictEqual(result.buffered,true);
  assert.strictEqual(h.sends.length,2);
  assert.strictEqual(h.edits.length,2);
  assert.strictEqual(h.getStored().remaining,0);
  assert.strictEqual(h.getStored().observedRemaining,4);

  result=await h.sync('2026-09-19T00:00:00Z');
  assert.strictEqual(result.advertised,1);
  assert.strictEqual(result.created,1);
  assert.strictEqual(result.remaining,4);
  assert.strictEqual(h.sends.length,3);
  assert.strictEqual(h.removes.length,2);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-19T00:00');

  // The first worker pass owns each slot. Availability appearing later in the
  // same slot is buffered until the next scheduled advert rather than leaking a
  // second post 30 seconds later.
  h.setRemaining(0);
  await h.sync('2026-09-19T00:00:10Z');
  h.setRemaining(2);
  result=await h.sync('2026-09-19T00:00:40Z');
  assert.strictEqual(result.buffered,true);
  assert.strictEqual(h.sends.length,3);
  assert.strictEqual(h.getStored().remaining,0);

  result=await h.sync('2026-09-19T12:00:00Z');
  assert.strictEqual(result.advertised,1);
  assert.strictEqual(h.sends.length,4);
  assert.strictEqual(h.getStored().remaining,2);

  // A failed scheduled POST must not consume the slot transition durably. The
  // next worker pass retries the same batched advert.
  h.setRemaining(0);
  await h.sync('2026-09-19T12:10:00Z');
  h.setRemaining(3);
  await h.sync('2026-09-19T18:00:00Z');
  h.failSend();
  await assert.rejects(h.sync('2026-09-20T00:00:00Z'),/simulated Discord POST failure/);
  assert.strictEqual(h.getStored().remaining,0);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-19T12:00');
  result=await h.sync('2026-09-20T00:00:30Z');
  assert.strictEqual(result.advertised,1);
  assert.strictEqual(h.getStored().remaining,3);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-20T00:00');

  // A missing canonical message during a downward edit is recreated as recovery
  // but is not treated as a scheduled availability advert.
  h.setRemaining(1);
  h.missEdit();
  const sendCountBeforeRecovery=h.sends.length;
  result=await h.sync('2026-09-20T00:05:00Z');
  assert.strictEqual(result.created,1);
  assert.strictEqual(result.availabilityRestored,0);
  assert.strictEqual(h.sends.length,sendCountBeforeRecovery+1);

  // Existing deployments without scheduled-state fields are baselined by a
  // quiet PATCH, not by a surprise fresh notification during deployment.
  const sendCountBeforeLegacy=h.sends.length;
  h.setStored({
    channelId:settings.discordFreePlacesChannelId,
    messageId:'legacy-message',
    text:'legacy-signature',
    remaining:null,
    updatedAt:null
  });
  h.setRemaining(5);
  result=await h.sync('2026-09-20T08:00:00Z');
  assert.strictEqual(result.legacyBaseline,true);
  assert.strictEqual(result.created,0);
  assert.strictEqual(h.sends.length,sendCountBeforeLegacy);
  assert.strictEqual(h.getStored().remaining,5);
  assert.strictEqual(h.getStored().observedRemaining,5);
  assert.strictEqual(h.getStored().lastAdvertSlot,'2026-09-20T00:00');

  assert(h.lockCount()>=16,'every digest observation/mutation must remain serialized');
  console.log('free places Discord scheduled batching smoke: ok');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
