'use strict';

require('dotenv').config();
process.env.NODE_ENV='test';

const assert=require('assert');
const bcrypt=require('bcryptjs');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const customers=require('../src/customers');

const suffix=crypto.randomBytes(6).toString('hex');
const username=`token-atomic-${suffix}`;
const email=`token-atomic-${suffix}@example.invalid`;
const originalPassword=`Original token password ${suffix} !`;
const replacementPassword=`Replacement token password ${suffix} !`;
const triggerName='test_fail_account_token_consume';
const functionName='test_fail_account_token_consume_fn';

function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||'')).digest('hex');}

async function installConsumeFailure(){
  await query(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION 'forced account token consume failure';
      END IF;
      RETURN NEW;
    END;
  $$`);
  await query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF consumed_at ON account_tokens FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
}

async function removeConsumeFailure(){
  await query(`DROP TRIGGER IF EXISTS ${triggerName} ON account_tokens`);
  await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
}

async function tokenRow(raw,type){
  const found=await query(`SELECT * FROM account_tokens WHERE token_hash=$1 AND token_type=$2`,[tokenHash(raw),type]);
  return found.rows[0]||null;
}

async function userRow(userId){
  return(await query(`SELECT id,email_verified_at,password_hash,session_version FROM app_users WHERE id=$1`,[userId])).rows[0]||null;
}

async function main(){
  try{
    const passwordHash=await bcrypt.hash(originalPassword,4);
    const user=(await query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NULL) RETURNING id,session_version`,[email,username,passwordHash])).rows[0];
    await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3)`,[user.id,username,email]);

    // Email verification updates the account first and token second. Force the
    // final token-consume write to fail and prove the earlier account update is
    // rolled back with it.
    const verification=await customers.createAccountToken(user.id,'email_verify',60);
    await installConsumeFailure();
    await assert.rejects(()=>customers.verifyEmail(verification.token),/forced account token consume failure/,'Email verification should surface the forced persistence failure');
    let token=await tokenRow(verification.token,'email_verify');
    let account=await userRow(user.id);
    assert(token&&!token.consumed_at,'Failed email verification consumed its one-time token');
    assert.strictEqual(account.email_verified_at,null,'Failed email verification left the account verified');
    await removeConsumeFailure();
    assert.strictEqual(await customers.verifyEmail(verification.token),true,'Email verification could not retry after rollback');
    token=await tokenRow(verification.token,'email_verify');
    account=await userRow(user.id);
    assert(token?.consumed_at,'Successful email verification did not consume its token');
    assert(account.email_verified_at,'Successful email verification did not update the account');

    // Password reset performs password/session/audit work before the final token
    // consume. Force that last write to fail and verify every earlier mutation
    // rolls back, leaving the same reset link retryable.
    const reset=await customers.createAccountToken(user.id,'password_reset',60);
    const sessionId=`token-atomic-session-${suffix}`;
    await query(`INSERT INTO auth_sessions(session_id,user_id,role,session_version,expires_at) VALUES($1,$2,'customer',$3,NOW()+INTERVAL '1 day')`,[sessionId,user.id,Number(account.session_version||1)]);
    const beforeReset=await userRow(user.id);
    await installConsumeFailure();
    await assert.rejects(()=>customers.resetSitePassword(reset.token,replacementPassword),/forced account token consume failure/,'Password reset should surface the forced persistence failure');
    token=await tokenRow(reset.token,'password_reset');
    account=await userRow(user.id);
    const failedSession=(await query(`SELECT revoked_at FROM auth_sessions WHERE session_id=$1`,[sessionId])).rows[0];
    const failedAudit=await query(`SELECT COUNT(*)::int n FROM audit_log WHERE action='customer.password.reset' AND entity_id=$1::text`,[user.id]);
    assert(token&&!token.consumed_at,'Failed password reset consumed its one-time token');
    assert.strictEqual(account.password_hash,beforeReset.password_hash,'Failed password reset changed the stored password');
    assert.strictEqual(Number(account.session_version),Number(beforeReset.session_version),'Failed password reset advanced the account session version');
    assert.strictEqual(failedSession?.revoked_at,null,'Failed password reset revoked an existing customer session');
    assert.strictEqual(Number(failedAudit.rows[0].n),0,'Failed password reset committed its audit event');
    await removeConsumeFailure();

    assert.strictEqual(await customers.resetSitePassword(reset.token,replacementPassword),true,'Password reset could not retry after rollback');
    token=await tokenRow(reset.token,'password_reset');
    account=await userRow(user.id);
    const completedSession=(await query(`SELECT revoked_at FROM auth_sessions WHERE session_id=$1`,[sessionId])).rows[0];
    assert(token?.consumed_at,'Successful password reset did not consume its token');
    assert.notStrictEqual(account.password_hash,beforeReset.password_hash,'Successful password reset did not change the password');
    assert.strictEqual(Number(account.session_version),Number(beforeReset.session_version)+1,'Successful password reset did not advance session version');
    assert(completedSession?.revoked_at,'Successful password reset did not revoke existing sessions');
    assert.strictEqual(await bcrypt.compare(replacementPassword,account.password_hash),true,'Successful password reset stored the wrong password');

    console.log('account token atomicity smoke: ok');
  }finally{
    await removeConsumeFailure().catch(()=>{});
    await getPool().end();
  }
}

main().catch(error=>{console.error(error);process.exit(1)});