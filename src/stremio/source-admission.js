'use strict';

const crypto=require('crypto');
const {transaction,query}=require('../db');

const LEASE_SECONDS=150;
function issue(){return crypto.randomBytes(24).toString('base64url');}
function hash(raw){const value=String(raw||'').trim();if(value.length<24||value.length>200)throw new Error('Invalid Stremio playback lease.');return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
function cleanMetadata(metadata={}){
  return{
    managedMappingId:metadata.managedMappingId||null,
    serverId:metadata.serverId||null,
    jellyfinUserId:metadata.jellyfinUserId||null,
    deviceId:metadata.deviceId?String(metadata.deviceId).slice(0,160):null,
    playSessionId:metadata.playSessionId?String(metadata.playSessionId).slice(0,300):null,
    mediaSourceId:metadata.mediaSourceId?String(metadata.mediaSourceId).slice(0,300):null
  };
}
async function admit(entitlement,rawLease,sourceId,itemId,metadata={}){
  const leaseHash=hash(rawLease),entitlementId=entitlement?.id,customerId=entitlement?.customer_id,meta=cleanMetadata(metadata);
  if(!entitlementId||!customerId)return{allowed:false,reason:'invalid_entitlement',active:0,limit:0};
  return transaction(async db=>{
    const locked=await db.query(`SELECT id,customer_id,stream_limit,status FROM stremio_entitlements WHERE id=$1 FOR UPDATE`,[entitlementId]);
    if(!locked.rowCount||locked.rows[0].status!=='active')return{allowed:false,reason:'inactive_entitlement',active:0,limit:0};
    const limit=Math.max(1,Math.min(50,Number(locked.rows[0].stream_limit||entitlement.stream_limit||1)));
    // External/proxy leases can be removed immediately. Managed leases carry
    // per-playback Jellyfin tokens and are revoked by managed-playback-lifecycle.
    await db.query(`DELETE FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at<=NOW() AND managed_mapping_id IS NULL`,[entitlementId]);
    const existing=await db.query(`SELECT lease_hash,source_id,item_id FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2`,[leaseHash,entitlementId]);
    if(existing.rowCount){
      await db.query(`UPDATE stremio_source_playback_leases SET source_id=$3,item_id=$4,last_seen_at=NOW(),expires_at=NOW()+($5||' seconds')::interval,
        managed_mapping_id=$6,server_id=$7,jellyfin_user_id=$8,device_id=$9,play_session_id=$10,media_source_id=$11,
        lifecycle_started_at=CASE WHEN $6::uuid IS NULL THEN lifecycle_started_at ELSE COALESCE(lifecycle_started_at,NOW()) END,
        lifecycle_last_seen_at=CASE WHEN $6::uuid IS NULL THEN lifecycle_last_seen_at ELSE NOW() END
        WHERE lease_hash=$1 AND entitlement_id=$2`,[leaseHash,entitlementId,sourceId,String(itemId),String(LEASE_SECONDS),meta.managedMappingId,meta.serverId,meta.jellyfinUserId,meta.deviceId,meta.playSessionId,meta.mediaSourceId]);
      const count=await db.query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]);
      return{allowed:true,existing:true,active:Number(count.rows[0]?.n||1),limit,leaseHash};
    }
    const count=await db.query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]),active=Number(count.rows[0]?.n||0);
    if(active>=limit)return{allowed:false,reason:'stream_limit',active,limit};
    await db.query(`INSERT INTO stremio_source_playback_leases(lease_hash,entitlement_id,customer_id,source_id,item_id,first_seen_at,last_seen_at,expires_at,managed_mapping_id,server_id,jellyfin_user_id,device_id,play_session_id,media_source_id,lifecycle_started_at,lifecycle_last_seen_at)
      VALUES($1,$2,$3,$4,$5,NOW(),NOW(),NOW()+($6||' seconds')::interval,$7,$8,$9,$10,$11,$12,CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() END,CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() END)`,[leaseHash,entitlementId,customerId,sourceId,String(itemId),String(LEASE_SECONDS),meta.managedMappingId,meta.serverId,meta.jellyfinUserId,meta.deviceId,meta.playSessionId,meta.mediaSourceId]);
    return{allowed:true,existing:false,active:active+1,limit,leaseHash};
  });
}
async function touch(entitlementId,rawLease){let leaseHash;try{leaseHash=hash(rawLease);}catch{return false;}const r=await query(`UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),lifecycle_last_seen_at=CASE WHEN managed_mapping_id IS NULL THEN lifecycle_last_seen_at ELSE NOW() END,expires_at=NOW()+($3||' seconds')::interval WHERE lease_hash=$1 AND entitlement_id=$2 AND expires_at>NOW()-INTERVAL '30 seconds'`,[leaseHash,entitlementId,String(LEASE_SECONDS)]);return r.rowCount>0;}
async function touchHash(leaseHash,{seconds=LEASE_SECONDS}={}){const value=String(leaseHash||'');if(!/^[a-f0-9]{64}$/.test(value))return false;const r=await query(`UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),lifecycle_last_seen_at=NOW(),expires_at=NOW()+($2||' seconds')::interval WHERE lease_hash=$1`,[value,String(Math.max(30,Math.min(600,Number(seconds)||LEASE_SECONDS)))]);return r.rowCount>0;}
async function release(entitlementId,rawLease){let leaseHash;try{leaseHash=hash(rawLease);}catch{return false;}const r=await query(`DELETE FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2`,[leaseHash,entitlementId]);return r.rowCount>0;}
async function releaseHash(leaseHash){const value=String(leaseHash||'');if(!/^[a-f0-9]{64}$/.test(value))return false;const r=await query(`DELETE FROM stremio_source_playback_leases WHERE lease_hash=$1`,[value]);return r.rowCount>0;}
async function active(entitlementId){const r=await query(`SELECT COUNT(*)::int n FROM stremio_source_playback_leases WHERE entitlement_id=$1 AND expires_at>NOW()`,[entitlementId]);return Number(r.rows[0]?.n||0);}
async function cleanup(limit=1000){const r=await query(`DELETE FROM stremio_source_playback_leases WHERE lease_hash IN (SELECT lease_hash FROM stremio_source_playback_leases WHERE expires_at<=NOW() AND managed_mapping_id IS NULL ORDER BY expires_at LIMIT $1)`,[Math.max(1,Math.min(10000,Number(limit)||1000))]);return r.rowCount;}

module.exports={LEASE_SECONDS,issue,hash,cleanMetadata,admit,touch,touchHash,release,releaseHash,active,cleanup};
