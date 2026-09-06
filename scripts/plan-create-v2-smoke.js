'use strict';

const {query,getPool}=require('../src/db');
const planCreate=require('../src/platform/admin-plan-create-v2');

const CODES=['smoke-v2-stremio','smoke-v2-jellyfin'];
function assert(value,message){if(!value)throw new Error(message);}
async function cleanup(){await query('DELETE FROM plans WHERE code=ANY($1::text[])',[CODES]);}

function common(code,name,serviceType){return{
  __submitted:'1',code,name,description:`${serviceType} canonical create smoke`,serviceType,
  audience:'direct',billingInterval:'month',durationDays:'30',price:'6',currency:'USD',
  capacityLimit:'20',streams:'1',sortOrder:'100',visible:'on',active:'on'
};}

async function main(){
  await cleanup();
  try{
    // Exact contract represented by the production Stremio creation form.
    const stremio=planCreate.parse(common('smoke-v2-stremio','Stremio Plan','stremio'));
    assert(stremio.serviceType==='stremio','Canonical parser changed Stremio delivery type');
    assert(stremio.inactivityPolicy&&Object.keys(stremio.inactivityPolicy).length===0,'Stremio must not receive Jellyfin lifecycle configuration');
    const createdStremio=await planCreate.create(stremio,null);
    const storedStremio=(await query('SELECT * FROM plans WHERE id=$1',[createdStremio.id])).rows[0];
    assert(storedStremio.service_type==='stremio','Canonical V2 create did not store Stremio service type');
    assert(Number(storedStremio.capacity_limit)===20,'Canonical V2 create did not store Stremio inventory');
    assert(Number(storedStremio.streams)===1,'Canonical V2 create did not store stream limit');
    assert(storedStremio.inactivity_policy&&Object.keys(storedStremio.inactivity_policy).length===0,'Stored Stremio lifecycle policy must remain empty');

    let badBundle=null;
    try{planCreate.parse({...common('unused-bundle','Bundle','bundle'),serverClass:'premium',allowAudioTranscoding:'on',allowRemoteAccess:'on'});}catch(error){badBundle=error;}
    assert(/Choose Jellyfin or Stremio/.test(String(badBundle?.message||'')),'Bundle creation must be rejected by the canonical plan form');

    const jellyfin=planCreate.parse({...common('smoke-v2-jellyfin','Jellyfin','jellyfin'),serverClass:'premium',allowAudioTranscoding:'on',allowRemoteAccess:'on'});
    assert(jellyfin.serviceType==='jellyfin','Jellyfin parsing failed');
    assert(jellyfin.inactivityPolicy&&Object.keys(jellyfin.inactivityPolicy).length===0,'New Jellyfin plans must not carry per-plan lifecycle configuration');
    await planCreate.create(jellyfin,null);

    // Retired lifecycle fields from stale clients are ignored rather than becoming
    // plan-scoped configuration again. Free inactivity is controlled globally.
    const staleStremio=planCreate.parse({...common('unused-stremio','Stale Stremio','stremio'),inactivityEnabled:'on',noPlaybackDays:'7'});
    assert(staleStremio.inactivityPolicy&&Object.keys(staleStremio.inactivityPolicy).length===0,'Retired lifecycle fields must not reactivate plan-scoped policy');

    console.log('canonical V2 plan creation smoke: ok');
  }finally{
    await cleanup();
    await getPool().end();
  }
}

main().catch(async error=>{
  console.error(error);
  try{await cleanup();}catch(_){}
  try{await getPool().end();}catch(_){}
  process.exit(1);
});
