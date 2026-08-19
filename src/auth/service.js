'use strict';
const engine=require('./service-engine');
const runtimeSettings=require('../platform/runtime-settings');
const operations=require('../platform/operations-settings');
const {query}=require('../db');
const totp=require('./totp');
function requiresTwoFactor(user){if(!user)return false;if(user.totp_enabled)return true;if(user.role==='admin')return runtimeSettings.requireAdminTwoFactor();return false}
async function beginTotpEnrollment(userId){await runtimeSettings.ensureLoaded().catch(()=>{});const result=await engine.beginTotpEnrollment(userId),user=await engine.getStaffById(userId);return{...result,uri:totp.otpauthUri({secret:result.secret,accountName:user?.email||user?.username||'account',issuer:runtimeSettings.siteName()})}}
async function registerSession(req,user){await engine.registerSession(req,user);const cfg=await operations.get().catch(()=>operations.DEFAULTS),hours=Math.max(1,Math.min(24*30,Number(cfg.staffSessionHours||12)));await query(`UPDATE auth_sessions SET expires_at=NOW()+($2::int*INTERVAL '1 hour'),last_seen_at=NOW() WHERE session_id=$1`,[req.sessionID,hours]);return true}
// service-engine retains the historical login-only compatibility shortcut. At
// the canonical service boundary an explicit call to verifySecondFactor means
// the caller really is asking for step-up. Temporarily mark authentication as
// pending so the engine cannot auto-pass merely because the same user already
// owns the session. Login challenges already have pendingStaffAuth and continue
// to behave identically. Accounts without required/enrolled 2FA still follow
// the configured optional policy.
async function verifySecondFactor(userId,token,req){if(!req?.session)return engine.verifySecondFactor(userId,token,req);const prior=req.session.pendingStaffAuth;req.session.pendingStaffAuth=prior||{stepUp:true,userId:String(userId)};try{return await engine.verifySecondFactor(userId,token,req)}finally{if(prior===undefined)delete req.session.pendingStaffAuth;else req.session.pendingStaffAuth=prior}}
module.exports={...engine,requiresTwoFactor,beginTotpEnrollment,registerSession,verifySecondFactor};
