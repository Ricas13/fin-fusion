'use strict';

const bcrypt=require('bcryptjs');
const customers=require('../customers');
const {transaction}=require('../db');

async function setPortalPassword({targetUserId,actorUserId,newPassword}){
  if(!targetUserId||!actorUserId)throw new Error('Impersonation identity is incomplete.');
  await customers.validateNewPassword(newPassword);
  const passwordHash=await bcrypt.hash(String(newPassword),12);
  return transaction(async client=>{
    const existing=await client.query(`SELECT id FROM app_users WHERE id=$1 AND role='customer' AND active=TRUE FOR UPDATE`,[targetUserId]);
    if(!existing.rowCount)throw new Error('Customer account not found.');
    const sessions=await client.query(`SELECT session_id FROM auth_sessions WHERE user_id=$1 AND role='customer' AND revoked_at IS NULL`,[targetUserId]);
    const ids=sessions.rows.map(row=>row.session_id);
    const updated=await client.query(`UPDATE app_users SET password_hash=$2,password_changed_at=NOW(),session_version=session_version+1,updated_at=NOW() WHERE id=$1 RETURNING session_version`,[targetUserId,passwordHash]);
    await client.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND role='customer'`,[targetUserId]);
    if(ids.length)await client.query(`DELETE FROM user_sessions WHERE sid=ANY($1::text[])`,[ids]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.impersonation.portal_password_set','app_user',$2,$3::jsonb)`,[actorUserId,targetUserId,JSON.stringify({targetUserId,revokedSessions:ids.length,oldPasswordRead:false})]);
    return{sessionVersion:Number(updated.rows[0].session_version),revokedSessions:ids.length};
  });
}

function rewriteSecurityPage(html){
  if(typeof html!=='string')return html;
  const action='action="/account/security/password"';
  const marker=html.indexOf(action);
  if(marker<0)return html;
  const formStart=html.lastIndexOf('<form',marker);
  const formEnd=html.indexOf('</form>',marker);
  if(formStart<0||formEnd<0)return html;
  const close=formEnd+'</form>'.length;
  const form=html.slice(formStart,close);
  const current=/<div class="field"><label>Current password<\/label><input class="input" type="password" name="currentPassword" required><\/div>/;
  const notice='<div class="notice warn">Admin impersonation: set a new portal password without knowing or revealing the customer\'s existing password. Existing customer sessions will be signed out.</div>';
  const rewritten=form.replace(current,notice).replace('Change password &amp; sign out other sessions','Set portal password &amp; sign out customer sessions').replace('Change password & sign out other sessions','Set portal password & sign out customer sessions');
  return html.slice(0,formStart)+rewritten+html.slice(close);
}

module.exports={setPortalPassword,rewriteSecurityPage};
