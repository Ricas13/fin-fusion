'use strict';

const assert=require('assert');
const db=require('../src/db');

const originalQuery=db.query,originalTransaction=db.transaction;
const entitlements=new Map(),leases=new Map();
let serial=Promise.resolve();
function now(){return Date.now();}
function activeFor(entitlementId){return [...leases.values()].filter(row=>row.entitlement_id===entitlementId&&row.expires_at>now());}
async function fakeQuery(sql,params=[]){
  const text=String(sql).replace(/\s+/g,' ').trim();
  if(text.startsWith('SELECT id,customer_id,stream_limit,status FROM stremio_entitlements')){
    const row=entitlements.get(params[0]);return{rowCount:row?1:0,rows:row?[{...row}]:[]};
  }
  if(text.startsWith('DELETE FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at<=NOW()')){
    let count=0;for(const [key,row] of leases){if(row.entitlement_id===params[0]&&row.expires_at<=now()){leases.delete(key);count++;}}return{rowCount:count,rows:[]};
  }
  if(text.startsWith('SELECT lease_hash,source_id,item_id FROM stremio_source_playback_leases')){
    const row=leases.get(params[0]);const match=row&&row.entitlement_id===params[1]?row:null;return{rowCount:match?1:0,rows:match?[{...match}]:[]};
  }
  if(text.startsWith('UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),expires_at=')){
    const row=leases.get(params[0]);if(!row||row.entitlement_id!==params[1])return{rowCount:0,rows:[]};row.last_seen_at=now();row.expires_at=now()+Number(params[2])*1000;return{rowCount:1,rows:[]};
  }
  if(text.startsWith('SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1'))return{rowCount:1,rows:[{n:activeFor(params[0]).length}]};
  if(text.startsWith('INSERT INTO stremio_source_playback_leases(')){
    if(leases.has(params[0])){const error=new Error('duplicate lease');error.code='23505';throw error;}
    leases.set(params[0],{lease_hash:params[0],entitlement_id:params[1],customer_id:params[2],source_id:params[3],item_id:String(params[4]),first_seen_at:now(),last_seen_at:now(),expires_at:now()+Number(params[5])*1000});return{rowCount:1,rows:[]};
  }
  if(text.startsWith('DELETE FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2')){
    const row=leases.get(params[0]);if(!row||row.entitlement_id!==params[1])return{rowCount:0,rows:[]};leases.delete(params[0]);return{rowCount:1,rows:[]};
  }
  if(text.startsWith('DELETE FROM stremio_source_playback_leases WHERE lease_hash IN')){let count=0;for(const[key,row]of leases){if(row.expires_at<=now()){leases.delete(key);count++;}}return{rowCount:count,rows:[]};}
  throw new Error(`Unhandled source admission SQL: ${text}`);
}
function fakeTransaction(fn){
  const run=serial.then(()=>fn({query:fakeQuery}));serial=run.catch(()=>{});return run;
}

(async()=>{
  try{
    db.query=fakeQuery;db.transaction=fakeTransaction;
    delete require.cache[require.resolve('../src/stremio/source-admission')];
    const admission=require('../src/stremio/source-admission');
    const entitlement={id:'ent-1',customer_id:'customer-1',stream_limit:1};
    entitlements.set(entitlement.id,{id:entitlement.id,customer_id:entitlement.customer_id,stream_limit:1,status:'active'});
    const lease1=admission.issue(),lease2=admission.issue();
    assert.notEqual(lease1,lease2,'Playback leases must be unpredictable and unique');
    assert(!lease1.includes('customer-1'),'Playback lease must not encode customer identity');

    const first=await admission.admit(entitlement,lease1,'source-a','item-a');
    assert.equal(first.allowed,true,'First stream for a one-stream plan must be admitted');
    assert.equal(first.active,1);assert.equal(first.limit,1);
    const retry=await admission.admit(entitlement,lease1,'source-a','item-a');
    assert.equal(retry.allowed,true,'Range/retry requests for the same playback lease must remain admitted');
    assert.equal(retry.existing,true);
    const mismatch=await admission.admit(entitlement,lease1,'source-b','item-a');
    assert.equal(mismatch.allowed,false,'A playback lease must not be reusable on another source');
    assert.equal(mismatch.reason,'lease_scope_mismatch');
    const blocked=await admission.admit(entitlement,lease2,'source-a','item-b');
    assert.equal(blocked.allowed,false,'A second concurrent stream must be blocked for a one-stream plan');
    assert.equal(blocked.reason,'stream_limit');
    assert.equal(await admission.active(entitlement.id),1);
    assert.equal(await admission.release(entitlement.id,lease1),true,'Failed/ended admission must be releasable');
    const afterRelease=await admission.admit(entitlement,lease2,'source-a','item-b');
    assert.equal(afterRelease.allowed,true,'A new stream must be admitted after the prior lease is released');

    await admission.release(entitlement.id,lease2);
    const lease3=admission.issue(),lease4=admission.issue();
    const simultaneous=await Promise.all([admission.admit(entitlement,lease3,'source-a','item-c'),admission.admit(entitlement,lease4,'source-a','item-d')]);
    assert.equal(simultaneous.filter(x=>x.allowed).length,1,'Serialized admission must allow only one of two simultaneous first streams');
    assert.equal(simultaneous.filter(x=>!x.allowed&&x.reason==='stream_limit').length,1,'Serialized admission must reject the competing stream at the plan limit');

    entitlements.get(entitlement.id).status='suspended';
    const lease5=admission.issue(),inactive=await admission.admit(entitlement,lease5,'source-a','item-e');
    assert.equal(inactive.allowed,false,'Suspended Stremio entitlement must never receive a new playback lease');
    assert.equal(inactive.reason,'inactive_entitlement');
    console.log('stremio source admission smoke: ok');
  }finally{
    db.query=originalQuery;db.transaction=originalTransaction;
    delete require.cache[require.resolve('../src/stremio/source-admission')];
  }
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
