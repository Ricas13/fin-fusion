'use strict';
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('child_process');
const { query, getPool } = require('../src/db');
const auth = require('../src/auth/service');
const totp = require('../src/auth/totp');
const serverAdmin = require('../src/platform/admin-servers');
const adminDashboard = require('../src/platform/admin-dashboard');
const USERNAME = 'ci-auth-smoke-admin';
const STARTUP_SECRET = 'ci-auth-smoke-session-secret-2026-0123456789abcdef';
function mockReq(sessionID = 'ci-auth-smoke-session') { return { ip:'127.0.0.1', sessionID, get(name){ return String(name).toLowerCase()==='user-agent'?'steam-fusion-auth-smoke/1':''; } }; }
function applicationStatus(overrides){
  return spawnSync(process.execPath,['-e',"require('./src/application').createApplication(); process.exit(0)"],{
    cwd:process.cwd(),
    env:{...process.env,SESSION_SECRET:STARTUP_SECRET,...overrides},
    encoding:'utf8'
  });
}
function assertStartupPolicy(){
  if(applicationStatus({NODE_ENV:'production',DATABASE_URL:'',REQUIRE_ADMIN_2FA:'true'}).status===0) throw new Error('Production accepted missing database configuration');
  const optional=applicationStatus({NODE_ENV:'production',REQUIRE_ADMIN_2FA:'false'}); if(optional.status!==0) throw new Error(`Production rejected optional administrator 2FA: ${optional.stderr||optional.stdout}`);
  const required=applicationStatus({NODE_ENV:'production',REQUIRE_ADMIN_2FA:'true'}); if(required.status!==0) throw new Error(`Valid production application startup failed: ${required.stderr||required.stdout}`);
}
function assertAdminErrorRedaction(){
  if(serverAdmin.safeAdminError({code:'23505'})!=='A server with that name or slug already exists.') throw new Error('Duplicate server error was not sanitized');
  const hidden=serverAdmin.safeAdminError(new Error('SECRET_INTERNAL_DATABASE_DETAIL'));
  if(hidden!=='The server change could not be completed safely.'||hidden.includes('SECRET_INTERNAL')) throw new Error('Unexpected server error details were exposed');
}
async function cleanup(userId=null){ if(userId) await query('DELETE FROM auth_events WHERE user_id=$1',[userId]); await query('DELETE FROM auth_events WHERE identity_hint=$1',[USERNAME]); await query('DELETE FROM app_users WHERE username=$1',[USERNAME]); }
async function main(){
  assertStartupPolicy(); assertAdminErrorRedaction();
  const dash = await adminDashboard.dashboardData();
  for (const key of ['customers','activeSubscriptions','activeStreams','transcodes','servers','healthyServers','offlineServers','wouldStop24h','safetySkips24h']) {
    if (!Number.isFinite(dash[key])) throw new Error(`Admin dashboard metric invalid: ${key}`);
  }
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
    console.log('Auth and admin dashboard smoke tests passed');
  }finally{ await cleanup(userId); await getPool().end(); }
}
main().catch(async error=>{ console.error(error); try{await cleanup();}catch(_){} try{await getPool().end();}catch(_){} process.exit(1); });
