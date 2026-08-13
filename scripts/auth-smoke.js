'use strict';
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('child_process');
const { query, getPool } = require('../src/db');
const auth = require('../src/auth/service');
const totp = require('../src/auth/totp');
const USERNAME = 'ci-auth-smoke-admin';
function mockReq(sessionID = 'ci-auth-smoke-session') { return { ip:'127.0.0.1', sessionID, get(name){ return String(name).toLowerCase()==='user-agent'?'steam-fusion-auth-smoke/1':''; } }; }
function preloadStatus(overrides){ return spawnSync(process.execPath,['-e',"require('./staff-auth-preload.js')"],{cwd:process.cwd(),env:{...process.env,...overrides},encoding:'utf8'}); }
function assertStartupPolicy(){
  if(preloadStatus({NODE_ENV:'production',DATABASE_URL:'',REQUIRE_ADMIN_2FA:'true'}).status===0) throw new Error('Production accepted missing database configuration');
  if(preloadStatus({NODE_ENV:'production',REQUIRE_ADMIN_2FA:'false'}).status===0) throw new Error('Production accepted disabled administrator 2FA');
  const ok=preloadStatus({NODE_ENV:'production',REQUIRE_ADMIN_2FA:'true'}); if(ok.status!==0) throw new Error('Valid production preload failed');
}
async function cleanup(userId=null){ if(userId) await query('DELETE FROM auth_events WHERE user_id=$1',[userId]); await query('DELETE FROM auth_events WHERE identity_hint=$1',[USERNAME]); await query('DELETE FROM app_users WHERE username=$1',[USERNAME]); }
async function main(){
  assertStartupPolicy();
  const vectorSecret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; if(totp.totp(vectorSecret,{time:59000,digits:8})!=='94287082') throw new Error('TOTP vector failed');
  await cleanup(); const password=crypto.randomBytes(24).toString('base64url')+'Aa1!';
  const inserted=await query("INSERT INTO app_users(username,password_hash,role,active,legacy_numeric_id,password_changed_at) VALUES($1,$2,'admin',TRUE,987654,NOW()) RETURNING id",[USERNAME,await bcrypt.hash(password,12)]); const userId=inserted.rows[0].id;
  try{
    if(await auth.authenticateStaff(USERNAME,password+'x',mockReq())) throw new Error('Invalid password accepted');
    const user=await auth.authenticateStaff(USERNAME,password,mockReq()); if(!user||user.role!=='admin') throw new Error('Valid staff authentication failed');
    const enrollment=await auth.beginTotpEnrollment(userId); const codes=await auth.confirmTotpEnrollment(userId,totp.totp(enrollment.secret),mockReq()); if(!Array.isArray(codes)||codes.length!==10) throw new Error('2FA enrollment failed');
    if(!(await auth.verifySecondFactor(userId,totp.totp(enrollment.secret),mockReq()))) throw new Error('TOTP verification failed');
    if(!(await auth.verifySecondFactor(userId,codes[0],mockReq()))) throw new Error('Recovery verification failed'); if(await auth.verifySecondFactor(userId,codes[0],mockReq())) throw new Error('Recovery code reused');
    const refreshed=await auth.getStaffById(userId); await auth.registerSession(mockReq(),refreshed); const session=await query('SELECT 1 FROM auth_sessions WHERE session_id=$1 AND user_id=$2',['ci-auth-smoke-session',userId]); if(!session.rowCount) throw new Error('Staff session registration failed');
    console.log('Auth smoke test passed');
  }finally{ await cleanup(userId); await getPool().end(); }
}
main().catch(async error=>{ console.error(error); try{await cleanup();}catch(_){} try{await getPool().end();}catch(_){} process.exit(1); });
