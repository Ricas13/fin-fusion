'use strict';
const core=require('./service-core');
const runtimeSettings=require('../platform/runtime-settings');
const totp=require('./totp');
function requiresTwoFactor(user){if(!user)return false;if(user.totp_enabled)return true;if(user.role==='admin')return runtimeSettings.requireAdminTwoFactor();if(user.role==='reseller')return runtimeSettings.requireResellerTwoFactor();return false}
async function beginTotpEnrollment(userId){await runtimeSettings.ensureLoaded().catch(()=>{});const result=await core.beginTotpEnrollment(userId),user=await core.getStaffById(userId);return{...result,uri:totp.otpauthUri({secret:result.secret,accountName:user?.email||user?.username||'account',issuer:runtimeSettings.siteName()})}}
module.exports={...core,requiresTwoFactor,beginTotpEnrollment};
