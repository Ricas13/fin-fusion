'use strict';

const crypto=require('crypto');
const {transaction,query}=require('../db');

const LEASE_SECONDS=150;
function issue(){return crypto.randomBytes(24).toString('base64url');}
function hash(raw){const value=String(raw||'').trim();if(value.length<24||value.length>200)throw new Error('Invalid Stremio playback lease.');return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
async function admit(entitlement,rawLease,sourceId,itemId){
  const leaseHash=hash(rawLease),entitlementId=entitlement?.id,customerId=entitlement?.customer_id;
  if(!entitlementId||!customerId)return{allowed:false,reason:'invalid_entitlement',active:0,limit:0};
  return transaction(async db=>{
    const locked=await db.query(`SELECT id,customer_id,stream_limit,status FROM stremio_entitlements WHERE id=$1 FOR UPDATE`,[entitlementId]);
    if(!locked.rowCount||locked.rows[0].status!=='active')return{allowed:false,reason:'inactive_entitlement',active:0,limit:0};
    const limit=Math.max(1,Math.min(50,Number(locked.rows[0].stream_limit||entitlement.stream_limit||1)));
    await db.query(`DELETE FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at<=NOW()`,[entitlementId]);
    const existing=await db.query(`SELECT lease_hash,source_id,item_id FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2`,[leaseHash,entitlementId]);
    if(existing.rowCount){
      if(String(existing.rows[0].source_id)!==String(sourceId)||String(existing.rows[0].item_id)!==String(itemId))return{allowed:false,reason:'lease_scope_mismatch',active:0,limit};
      await db.query(`UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),expires_at=NOW()+($3||' seconds')::interval WHERE lease_hash=$1 AND entitlement_id=$2`,[leaseHash,entitlementId,String(LEASE_SECONDS)]);
      const count=await db.query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]);
      return{allowed:true,existing:true,active:Number(count.rows[0]?.n||1),limit,leaseHash};
    }
    const count=await db.query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]),active=Number(count.rows[0]?.n||0);
    if(active>=limit)return{allowed:false,reason:'stream_limit',active,limit};
    await db.query(`INSERT INTO stremio_source_playback_leases(lease_hash,entitlement_id,customer_id,source_id,item_id,first_seen_at,last_seen_at,expires_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW(),NOW()+($6||' seconds')::interval)`,[leaseHash,entitlementId,customerId,sourceId,String(itemId),String(LEASE_SECONDS)]);
    return{allowed:true,existing:false,active:active+1,limit,leaseHash};
  });
}
async function touch(entitlementId,rawLease){let leaseHash;try{leaseHash=hash(rawLease);}catch{return false;}const r=await query(`UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),expires_at=NOW()+($3||' seconds')::interval WHERE lease_hash=$1 AND entitlement_id=$2 AND expires_at>NOW()-INTERVAL '30 seconds'`,[leaseHash,entitlementId,String(LEASE_SECONDS)]);return r.rowCount>0;}
async function active(entitlementId){const r=await query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]);return Number(r.rows[0]?.n||0);}
async function cleanup(limit=1000){const r=await query(`DELETE FROM stremio_source_playback_leases WHERE lease_hash IN (SELECT lease_hash FROM stremio_source_playback_leases WHERE expires_at<=NOW() ORDER BY expires_at LIMIT $1)`,[Math.max(1,Math.min(10000,Number(limit)||1000))]);return r.rowCount;}

module.exports={LEASE_SECONDS,issue,hash,admit,touch,active,cleanup};
