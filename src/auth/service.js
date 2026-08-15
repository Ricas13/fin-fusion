'use strict';
const core=require('./service-core');
const runtimeSettings=require('../platform/runtime-settings');
const operations=require('../platform/operations-settings');
const {query}=require('../db');
const totp=require('./totp');
function requiresTwoFactor(user){if(!user)return false;if(user.totp_enabled)return true;if(user.role==='admin')return runtimeSettings.requireAdminTwoFactor();if(user.role==='reseller')return runtimeSettings.requireResellerTwoFactor();return false}
async function beginTotpEnrollment(userId){await runtimeSettings.ensureLoaded().catch(()=>{});const result=await core.beginTotpEnrollment(userId),user=await core.getStaffById(userId);return{...result,uri:totp.otpauthUri({secret:result.secret,accountName:user?.email||user?.username||'account',issuer:runtimeSettings.siteName()})}}
async function registerSession(req,user){await core.registerSession(req,user);const cfg=await operations.get().catch(()=>operations.DEFAULTS),hours=Math.max(1,Math.min(24*30,Number(cfg.staffSessionHours||12)));await query(`UPDATE auth_sessions SET expires_at=NOW()+($2::int*INTERVAL '1 hour'),last_seen_at=NOW() WHERE session_id=$1`,[req.sessionID,hours]);return true}
module.exports={...core,requiresTwoFactor,beginTotpEnrollment,registerSession};
