'use strict';

const assert=require('assert');
const path=require('path');

const root=path.join(__dirname,'..');
function modulePath(relative){return require.resolve(path.join(root,relative));}
function stub(relative,exports){const filename=modulePath(relative);require.cache[filename]={id:filename,filename,loaded:true,exports};}

let passwordChecks=[];
let directQueries=[];
let txQueries=[];
let otherSessions=['other-a','other-b'];
let sessionVersion=7;
let breachChecks=[];

const client={
  async query(sql,params=[]){
    const compact=String(sql).replace(/\s+/g,' ').trim();
    txQueries.push({sql:compact,params});
    if(compact.includes('UPDATE app_users')&&compact.includes('totp_enabled=FALSE'))return{rows:[{id:params[0]}],rowCount:1};
    if(compact.includes('DELETE FROM auth_recovery_codes'))return{rows:[],rowCount:0};
    if(compact.includes('DELETE FROM auth_totp_enrollments'))return{rows:[],rowCount:0};
    if(compact.includes("'customer.2fa.disable'"))return{rows:[{id:'audit'}],rowCount:1};
    if(compact.includes('SET password_hash=$2')&&compact.includes('session_version=session_version+1'))return{rows:[{session_version:sessionVersion}],rowCount:1};
    if(compact.includes('SET session_version=session_version+1'))return{rows:[{session_version:sessionVersion}],rowCount:1};
    if(compact.includes('SELECT session_id FROM auth_sessions'))return{rows:otherSessions.map(session_id=>({session_id})),rowCount:otherSessions.length};
    if(compact.includes('UPDATE auth_sessions')&&compact.includes('session_id<>$2'))return{rows:[],rowCount:otherSessions.length};
    if(compact.includes('UPDATE auth_sessions')&&compact.includes('session_version=$3'))return{rows:[],rowCount:1};
    if(compact.includes('DELETE FROM user_sessions'))return{rows:[],rowCount:otherSessions.length};
    if(compact.includes("'customer.password.change'"))return{rows:[{id:'audit'}],rowCount:1};
    throw new Error('Unexpected security command transaction query: '+compact.slice(0,180));
  }
};

stub('src/db.js',{
  query:async(sql,params=[])=>{
    directQueries.push({sql:String(sql).replace(/\s+/g,' ').trim(),params});
    if(String(sql).includes('SELECT password_hash FROM app_users'))return{rows:[{password_hash:'hash:current-password'}],rowCount:1};
    if(String(sql).includes('UPDATE auth_sessions')&&String(sql).includes('RETURNING session_id'))return{rows:[{session_id:params[0]}],rowCount:1};
    throw new Error('Unexpected direct security query: '+String(sql).replace(/\s+/g,' ').slice(0,180));
  },
  transaction:async fn=>fn(client)
});
require.cache[require.resolve('bcryptjs')]={id:require.resolve('bcryptjs'),filename:require.resolve('bcryptjs'),loaded:true,exports:{
  compare:async(value,hash)=>hash===`hash:${value}`,
  hash:async value=>`hash:${value}`
}};
stub('src/security/password-breach.js',{
  assertNotBreached:async password=>{breachChecks.push(password);return true;}
});
stub('src/security/customer-email-change.js',{
  assertPassword:async(userId,password)=>{passwordChecks.push({userId,password});return true;}
});
stub('src/security/purpose-crypto.js',{
  keyFromEnv:()=>Buffer.alloc(32,1),
  encryptWithEnv:value=>`enc:${value}`,
  decryptWithEnv:value=>String(value).replace(/^enc:/,'')
});
stub('src/auth/totp.js',{
  base32Encode:buffer=>buffer.toString('hex').toUpperCase().padEnd(16,'A'),
  generateSecret:()=> 'SECRET',
  verifyTotp:()=>true,
  otpauthUri:()=> 'otpauth://fixture'
});

const commands=require('../src/security/customer-security-commands');

(async()=>{
  txQueries=[];
  passwordChecks=[];
  await commands.disableTwoFactor('user-1','current-password');
  assert.deepStrictEqual(passwordChecks,[{userId:'user-1',password:'current-password'}],'2FA disable must verify the current password through the canonical identity owner');
  assert.strictEqual(txQueries.length,4,'2FA disable must update state, clear both credential stores and audit atomically');
  assert(txQueries[0].sql.includes('totp_enabled=FALSE'),'2FA disable must clear the authenticator state');
  assert(txQueries[1].sql.includes('DELETE FROM auth_recovery_codes'),'2FA disable must clear recovery codes');
  assert(txQueries[2].sql.includes('DELETE FROM auth_totp_enrollments'),'2FA disable must clear pending enrollments');
  assert(txQueries[3].sql.includes("'customer.2fa.disable'"),'2FA disable audit must share the transaction');

  txQueries=[];
  otherSessions=['other-a','other-b'];
  sessionVersion=9;
  const bumped=await commands.bumpSecurityVersion('user-1','current');
  assert.deepStrictEqual(bumped,{version:9,revoked:2},'security-version bump must report the new version and revoked session count');
  assert(txQueries[0].sql.includes('session_version=session_version+1'),'security version must advance before session revocation');
  assert(txQueries.some(row=>row.sql.includes('session_id<>$2')&&row.sql.includes('revoked_at=NOW()')),'other authoritative auth sessions must be revoked');
  assert(txQueries.some(row=>row.sql.includes('SET session_version=$3')&&row.params[1]==='current'),'current auth session must be rebound to the new version');
  assert(txQueries.some(row=>row.sql.includes('DELETE FROM user_sessions')),'revoked browser sessions must be removed from the session store');

  txQueries=[];
  otherSessions=['other-a','other-b'];
  const revokedOthers=await commands.revokeOtherSessions('user-1','current');
  assert.strictEqual(revokedOthers,2,'other-session revocation must report exactly the revoked customer sessions');
  assert(txQueries.some(row=>row.sql.includes('UPDATE auth_sessions')&&row.sql.includes('session_id<>$2')),'other-session revocation must update canonical auth session state');
  assert(txQueries.some(row=>row.sql.includes('DELETE FROM user_sessions')),'other-session revocation must invalidate matching browser sessions atomically');

  txQueries=[];
  breachChecks=[];
  otherSessions=['other-a'];
  sessionVersion=11;
  const changed=await commands.changePassword('user-1','current-password','new-password','current');
  assert.deepStrictEqual(changed,{sessionVersion:11,revokedSessions:1},'password change must advance security version and report revoked sessions');
  assert.deepStrictEqual(breachChecks,['new-password'],'password change must retain breached-password screening');
  assert(txQueries.some(row=>row.sql.includes('SET password_hash=$2')&&row.sql.includes('session_version=session_version+1')),'password update and session-version bump must be atomic');
  assert(txQueries.some(row=>row.sql.includes("'customer.password.change'")),'password change must retain its audit event inside the transaction');

  directQueries=[];
  const revoked=await commands.revokeSession('user-1','current');
  assert.strictEqual(revoked,true,'current-session revocation must report success');
  assert(directQueries[0].sql.includes('role=\'customer\''),'session revocation must remain scoped to the customer role');

  console.log('customer security domain behavior smoke: ok');
})().catch(error=>{
  console.error(error);
  process.exit(1);
});
