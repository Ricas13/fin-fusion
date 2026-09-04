'use strict';

const assert=require('assert');
const freePlaces=require('../src/automation/free-places-digest');

const settings={
  discordFreePlacesDigestEnabled:true,
  discordConfigured:true,
  discordFreePlacesChannelId:'123456789012345678'
};
const operationsConfig={publicBaseUrl:'https://store.example.test'};

function harness(){
  let remaining=0,stored=null,sendSequence=0,failNextSend=false,missingNextEdit=false,lockCount=0;
  const sends=[],edits=[];
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
  const sync=()=>freePlaces.syncPersistent({settings,operationsConfig,usage,send,edit,transactionFn});
  return{
    sync,sends,edits,
    setRemaining:value=>{remaining=value;},
    getStored:()=>stored&&{...stored},
    setStored:value=>{stored=value&&{...value};},
    failSend:()=>{failNextSend=true;},
    missEdit:()=>{missingNextEdit=true;},
    lockCount:()=>lockCount
  };
}

(async()=>{
  assert.strictEqual(freePlaces.becameAvailable(0,1),true,'known 0 -> positive capacity must be a reopen transition');
  assert.strictEqual(freePlaces.becameAvailable(0,10),true,'0 -> many free places must be a reopen transition');
  assert.strictEqual(freePlaces.becameAvailable(null,1),false,'legacy/no prior capacity must not create a false reopen notification');
  assert.strictEqual(freePlaces.becameAvailable(1,2),false,'positive -> positive is a routine status edit');
  assert.strictEqual(freePlaces.becameAvailable(1,0),false,'positive -> zero is a routine status edit');
  assert.strictEqual(freePlaces.becameAvailable(0,0),false,'zero -> zero must not create a new message');

  const h=harness();

  // First installation creates the canonical status message once.
  h.setRemaining(0);
  let result=await h.sync();
  assert.strictEqual(result.created,1,'first status publication must create a Discord message');
  assert.strictEqual(result.availabilityRestored,0,'first publication is not a 0 -> positive transition');
  assert.strictEqual(h.sends.length,1);
  assert.strictEqual(h.edits.length,0);
  assert.strictEqual(h.getStored().remaining,0);
  assert.strictEqual(h.getStored().messageId,'message-1');

  // No capacity change is a durable no-op.
  result=await h.sync();
  assert.strictEqual(result.unchanged,true,'identical zero-capacity state should not touch Discord');
  assert.strictEqual(h.sends.length,1);
  assert.strictEqual(h.edits.length,0);

  // This is the important notification edge: full -> available POSTS fresh.
  h.setRemaining(2);
  result=await h.sync();
  assert.strictEqual(result.availabilityRestored,1,'0 -> positive must be identified as availability reopening');
  assert.strictEqual(result.created,1,'0 -> positive must POST a fresh Discord message');
  assert.strictEqual(h.sends.length,2,'reopening must create exactly one additional message');
  assert.strictEqual(h.edits.length,0,'reopening must bypass PATCH of the old full-capacity message');
  assert.strictEqual(h.sends[1].allowEveryone,false,'fresh reopen message must not use @everyone spam');
  assert.strictEqual(h.getStored().messageId,'message-2','fresh reopen message must become the canonical editable message');
  assert.strictEqual(h.getStored().remaining,2);

  // Once open, changing the count only edits the new canonical message.
  h.setRemaining(1);
  result=await h.sync();
  assert.strictEqual(result.created,0,'positive -> positive must not create another Discord message');
  assert.strictEqual(result.availabilityRestored,0);
  assert.strictEqual(h.sends.length,2);
  assert.strictEqual(h.edits.length,1);
  assert.strictEqual(h.edits[0].messageId,'message-2','routine changes must PATCH the newest canonical message');

  // Becoming full also edits in place, so filling the final place is quiet.
  h.setRemaining(0);
  result=await h.sync();
  assert.strictEqual(result.created,0,'positive -> zero must be an in-place edit');
  assert.strictEqual(h.sends.length,2);
  assert.strictEqual(h.edits.length,2);
  assert.strictEqual(h.getStored().remaining,0);

  result=await h.sync();
  assert.strictEqual(result.unchanged,true,'zero -> zero must remain quiet');
  assert.strictEqual(h.sends.length,2);
  assert.strictEqual(h.edits.length,2);

  // A failed reopen POST must not consume the durable transition. Retry should
  // still see previous=0 and publish one fresh message when Discord recovers.
  h.setRemaining(3);
  h.failSend();
  await assert.rejects(h.sync(),/simulated Discord POST failure/,'failed reopen POST must surface as a job failure');
  assert.strictEqual(h.getStored().remaining,0,'failed POST must leave durable prior capacity at zero');
  assert.strictEqual(h.getStored().messageId,'message-2','failed POST must leave the prior canonical message id intact');
  result=await h.sync();
  assert.strictEqual(result.availabilityRestored,1,'retry must still recognize the 0 -> positive transition');
  assert.strictEqual(result.created,1);
  assert.strictEqual(h.getStored().remaining,3);
  assert.strictEqual(h.getStored().messageId,'message-3');

  // A deleted canonical message is recreated, but this is recovery rather than
  // a false availability-restored signal.
  h.setRemaining(4);
  h.missEdit();
  result=await h.sync();
  assert.strictEqual(result.availabilityRestored,0);
  assert.strictEqual(result.created,1,'Discord 404 during a routine edit must recreate the status message');
  assert.strictEqual(h.getStored().messageId,'message-4');

  // Existing installations that predate the durable remaining field must not
  // falsely notify merely because they are upgraded while places are open.
  const sendCountBeforeLegacy=h.sends.length,editCountBeforeLegacy=h.edits.length;
  h.setStored({channelId:settings.discordFreePlacesChannelId,messageId:'legacy-message',text:'legacy-signature',remaining:null,updatedAt:null});
  h.setRemaining(5);
  result=await h.sync();
  assert.strictEqual(result.availabilityRestored,0,'unknown prior capacity is not proof of a 0 -> positive transition');
  assert.strictEqual(result.created,0,'legacy state with a valid message must be PATCHed rather than creating notification spam');
  assert.strictEqual(h.sends.length,sendCountBeforeLegacy);
  assert.strictEqual(h.edits.length,editCountBeforeLegacy+1);
  assert.strictEqual(h.edits.at(-1).messageId,'legacy-message');

  assert(h.lockCount()>=9,'every digest mutation decision must run under the advisory transaction lock');
  console.log('free places Discord notification smoke: ok');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});