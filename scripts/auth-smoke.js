'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('child_process');
const { query, getPool } = require('../src/db');
const auth = require('../src/auth/service');
const historicalAuth = require('../src/auth/service-core');
const adminSecurity = require('../src/platform/admin-security');
const historicalAdminSecurity = require('../src/platform/admin-security-core');
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
function assertAuthOwnership(){
  const root=path.join(__dirname,'..','src','auth');
  const service=fs.readFileSync(path.join(root,'service.js'),'utf8');
  const core=fs.readFileSync(path.join(root,'service-core.js'),'utf8');
  const engine=fs.readFileSync(path.join(root,'service-engine.js'),'utf8');
  if(historicalAuth!==auth) throw new Error('Historical auth service path does not resolve to canonical service');
  if(!/module\.exports\s*=\s*require\(['"]\.\/service['"]\)/.test(core)) throw new Error('service-core must delegate directly to canonical service');
  if(/\basync\s+function\b/.test(core)) throw new Error('service-core must not become a second auth implementation');
  if(!service.includes("require('./service-engine')")) throw new Error('Canonical auth service must use the internal auth engine');
  if(service.includes("require('./service-core')")) throw new Error('Canonical auth service must not depend on historical service-core');
  if(!service.includes('pendingStaffAuth=prior||{stepUp:true')) throw new Error('Canonical auth service must force explicit second-factor step-up');
  if(!service.includes('operations.get()')) throw new Error('Canonical auth service must honor runtime staff session duration');
  if(!service.includes('issuer:runtimeSettings.siteName()')) throw new Error('Canonical auth service must use runtime branding for TOTP enrollment');
  if(!engine.includes("eventType: '2fa.step_up_not_required'")) throw new Error('Internal auth engine copy is missing the login-only compatibility behavior wrapped by the canonical service');
  const engineImporters=fs.readdirSync(root).filter(name=>name.endsWith('.js')&&fs.readFileSync(path.join(root,name),'utf8').includes("require('./service-engine')"));
  if(JSON.stringify(engineImporters)!==JSON.stringify(['service.js'])) throw new Error(`Only service.js may import service-engine; got ${engineImporters.join(', ')}`);
}
function assertAdminSecurityOwnership(){
  const root=path.join(__dirname,'..','src','platform');
  const service=fs.readFileSync(path.join(root,'admin-security.js'),'utf8');
  const core=fs.readFileSync(path.join(root,'admin-security-core.js'),'utf8');
  const routes=fs.readFileSync(path.join(root,'admin-security-routes.js'),'utf8');
  if(historicalAdminSecurity!==adminSecurity) throw new Error('Historical admin-security path does not resolve to canonical step-up-protected service');
  if(historicalAdminSecurity.createAdminSecurityRouter!==adminSecurity.createAdminSecurityRouter) throw new Error('Historical admin-security constructor bypasses canonical router');
  if(!/module\.exports\s*=\s*require\(['"]\.\/admin-security['"]\)/.test(core)) throw new Error('admin-security-core must delegate directly to canonical admin-security');
  if(/\bfunction\s+createAdminSecurityRouter\b|\brouter\.(?:get|post|put|patch|delete)\(/.test(core)) throw new Error('admin-security-core must not own security routes');
  if(!service.includes("require('./admin-security-routes')")) throw new Error('Canonical admin-security must use the internal routes module');
  if(service.includes("require('./admin-security-core')")) throw new Error('Canonical admin-security must not depend on historical admin-security-core');
  if(!service.includes('stepUp.createAdminStepUpRouter()')) throw new Error('Canonical admin-security router must mount the administrator step-up challenge');
  if(!service.includes('stepUp.sensitiveMutationGuard')) throw new Error('Canonical admin-security router must retain the sensitive mutation guard');
  for(const route of [
    "router.post('/admin/security/2fa-policy'",
    "router.post('/admin/security/2fa/enable'",
    "router.post('/admin/security/2fa/disable'",
    "router.post('/admin/security/sessions/revoke-others'",
    "router.post('/admin/security/password'",
    "router.post('/admin/security/recovery/regenerate'"
  ]) if(!routes.includes(route)) throw new Error(`Internal admin security routes missing protected mutation: ${route}`);
  if(!routes.includes('setAdminTwoFactorPolicy')) throw new Error('Internal admin security routes must retain 2FA policy persistence');
  const routesImporters=fs.readdirSync(root).filter(name=>name.endsWith('.js')&&fs.readFileSync(path.join(root,name),'utf8').includes("require('./admin-security-routes')"));
  if(JSON.stringify(routesImporters)!==JSON.stringify(['admin-security.js'])) throw new Error(`Only admin-security.js may import admin-security-routes; got ${routesImporters.join(', ')}`);
}
async function cleanup(userId=null){ if(userId) await query('DELETE FROM auth_events WHERE user_id=$1',[userId]); await query('DELETE FROM auth_events WHERE identity_hint=$1',[USERNAME]); await query('DELETE FROM app_users WHERE username=$1',[USERNAME]); }
async function main(){
  assertStartupPolicy(); assertAdminErrorRedaction(); assertAuthOwnership(); assertAdminSecurityOwnership();
  ejs.compile(fs.readFileSync('views/admin/dashboard.ejs','utf8'));
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
    const established=mockReq('ci-auth-step-up-session'); established.session={authUserId:userId,authRole:'admin'};
    if(await auth.verifySecondFactor(userId,'definitely-not-a-valid-factor',established)) throw new Error('Explicit second-factor verification auto-passed an established admin session');
    if(await historicalAuth.verifySecondFactor(userId,'definitely-not-a-valid-factor',established)) throw new Error('Historical auth import bypassed canonical step-up enforcement');
    const refreshed=await auth.getStaffById(userId); await auth.registerSession(mockReq(),refreshed); const session=await query('SELECT 1 FROM auth_sessions WHERE session_id=$1 AND user_id=$2',['ci-auth-smoke-session',userId]); if(!session.rowCount) throw new Error('Staff session registration failed');
    console.log('Auth and admin dashboard smoke tests passed');
  }finally{ await cleanup(userId); await getPool().end(); }
}
main().catch(async error=>{ console.error(error); try{await cleanup();}catch(_){} try{await getPool().end();}catch(_){} process.exit(1); });
