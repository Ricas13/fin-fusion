'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const route=read('src/platform/admin-portal-credential-recovery.js');
const commands=read('src/security/admin-portal-credential-recovery.js');

assert(route.includes("require('../security/admin-portal-credential-recovery')"),
  'admin credential recovery route must delegate destructive security mutation to the security domain');
for(const forbidden of [
  'UPDATE app_users',
  'UPDATE customers',
  'DELETE FROM auth_recovery_codes',
  'DELETE FROM auth_totp_enrollments',
  'UPDATE auth_sessions',
  'DELETE FROM user_sessions',
  'UPDATE account_tokens'
]){
  assert(!route.includes(forbidden),`platform recovery route must not own destructive persistence: ${forbidden}`);
}
for(const required of [
  'FOR UPDATE OF c,u',
  'UPDATE app_users',
  'UPDATE customers',
  'DELETE FROM auth_recovery_codes',
  'DELETE FROM auth_totp_enrollments',
  'UPDATE auth_sessions',
  'DELETE FROM user_sessions',
  'UPDATE account_tokens',
  "'admin.customer.portal_credential_recovery'"
]){
  assert(commands.includes(required),`security recovery owner must retain ${required}`);
}
assert(commands.includes('transaction(async client=>'),
  'admin credential recovery must remain one serialized transaction');
assert(commands.includes("passwordPolicy.validateNewPassword(password)"),
  'admin credential recovery must preserve canonical password policy validation');

console.log('admin portal credential recovery domain smoke: ok');
