'use strict';
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const {query,transaction}=require('../db');
const customers=require('../customers');
const referrals=require('../referrals');
const planCapacity=require('../entitlements/plan-capacity');

const LOCK_SEED=761931;
const FREE_HOLD_MINUTES=20;
function cleanEmail(value){const email=String(value||'').trim().toLowerCase();if(!email||!email.includes('@')||email.length>254||/[\r\n<>]/.test(email))throw new Error('A valid email address is required');return email;}
function cleanUsername(value){const username=String(value||'').trim();if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))throw new Error('Username must be 3-40 characters using letters, numbers, dot, underscore or dash');return username;}
async function validatePassword(password){return customers.validateNewPassword(password);}
function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function cleanCommunicationPreferences(value={}){
    const phone=String(value.phone_e164||value.phone||'').trim().slice(0,32);
    const telegram=String(value.telegram_handle||value.telegram||'').trim().replace(/^@/,'').slice(0,64);
    const discord=String(value.discord_handle||value.discord||'').trim().slice(0,100);
    const whatsapp=Boolean(value.whatsapp_opt_in);
    if(whatsapp&&(!phone||!/^\+[1-9]\d{7,14}$/.test(phone.replace(/[\s()-]/g,''))))throw new Error('WhatsApp requires an international phone number such as +447700900123.');
    return {
        phone_e164:phone?phone.replace(/[\s()-]/g,''):null,
        whatsapp_opt_in:Boolean(phone&&whatsapp),
        telegram_handle:telegram||null,
        telegram_opt_in:Boolean(value.telegram_opt_in),
        discord_handle:discord||null,
        discord_opt_in:Boolean(value.discord_opt_in)
    };
}
async function serialize(client){await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:pending-registration',$1::bigint))`,[LOCK_SEED]);}
async function assertNoUnclaimedJellyfinUsername(client,username){const conflict=await client.query(`SELECT 1 FROM jellyfin_accounts ja JOIN customers c ON c.id=ja.customer_id WHERE c.user_id IS NULL AND lower(ja.jellyfin_username)=lower($1) LIMIT 1`,[username]);if(conflict.rowCount)throw new Error('That username belongs to an existing Jellyfin account. Use the existing-account claim link instead of creating a new account.');}
async function terminalize(client,pendingId,message){
    await client.query(`UPDATE pending_registrations SET consumed_at=COALESCE(consumed_at,NOW()),updated_at=NOW() WHERE id=$1`,[pendingId]);
    await client.query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()) WHERE pending_registration_id=$1 AND consumed_at IS NULL AND released_at IS NULL`,[pendingId]);
    return{terminalError:message};
}
async function canonicalFreePlan(client){
    const found=await client.query(`SELECT id,code,name,capacity_limit FROM plans WHERE active=TRUE AND visible=TRUE AND is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE AND audience IN('direct','both') AND price_minor=0 AND billing_interval<>'trial' AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY sort_order ASC,id ASC LIMIT 1`);
    return found.rows[0]||null;
}

async function begin({email,username,password,referralCode=null,communicationPreferences={},ttlMinutes=60,freeAccess=false}){
    email=cleanEmail(email);username=cleanUsername(username);await validatePassword(password);
    const prefs=cleanCommunicationPreferences(communicationPreferences);
    const passwordHash=await bcrypt.hash(password,12),raw=crypto.randomBytes(32).toString('base64url'),hash=tokenHash(raw),minutes=Math.max(10,Math.min(24*60,Number(ttlMinutes)||60)),expiresAt=new Date(Date.now()+minutes*60000),ref=String(referralCode||'').trim().toUpperCase().slice(0,20)||null;
    const row=await transaction(async client=>{
        await serialize(client);
        const banned=await client.query(`SELECT 1 FROM customer_bans WHERE revoked_at IS NULL AND blocks_registration=TRUE AND normalized_email=LOWER(BTRIM($1)) LIMIT 1`,[email]);
        if(banned.rowCount)throw new Error('Registration is not available for this email address');
        const exists=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) OR lower(username)=lower($2) LIMIT 1`,[email,username]);
        if(exists.rowCount)throw new Error('An account already exists with that email or username');
        await assertNoUnclaimedJellyfinUsername(client,username);
        await client.query(`DELETE FROM pending_registrations WHERE consumed_at IS NULL AND (expires_at<=NOW() OR lower(email)=lower($1) OR lower(username)=lower($2))`,[email,username]);
        const created=await client.query(`INSERT INTO pending_registrations(email,username,password_hash,referral_code,token_hash,expires_at,communication_preferences,free_access_requested) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id,email,username,expires_at,created_at,free_access_requested`,[email,username,passwordHash,ref,hash,expiresAt,JSON.stringify(prefs),Boolean(freeAccess)]);
        let freeReservation=null;
        if(freeAccess){
            const plan=await canonicalFreePlan(client);
            if(!plan)throw new Error('Free Access is not available for new claims right now.');
            const capacityState=await planCapacity.lockAndAssert(client,plan.id,plan.name||'Free Access');
            if(capacityState.limit!=null){
                const holdExpiresAt=new Date(Math.min(expiresAt.getTime(),Date.now()+FREE_HOLD_MINUTES*60000));
                freeReservation=(await client.query(`INSERT INTO free_access_registration_reservations(pending_registration_id,plan_id,normalized_email,expires_at) VALUES($1,$2,$3,$4) RETURNING id,plan_id,expires_at`,[created.rows[0].id,plan.id,email,holdExpiresAt])).rows[0];
            }else freeReservation={id:null,plan_id:plan.id,expires_at:expiresAt,unlimited:true};
        }
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.pending','pending_registration',$1,$2::jsonb)`,[created.rows[0].id,JSON.stringify({email,username,expiresAt,referral:Boolean(ref),freeAccess:Boolean(freeAccess),freeHoldExpiresAt:freeReservation?.expires_at||null,optionalChannels:{whatsapp:prefs.whatsapp_opt_in,telegram:prefs.telegram_opt_in,discord:prefs.discord_opt_in}})]);
        return{...created.rows[0],freeReservation};
    });
    return{...row,token:raw};
}

async function consume(rawToken){
    const hash=tokenHash(rawToken),created=await transaction(async client=>{
        await serialize(client);
        const found=await client.query(`SELECT * FROM pending_registrations WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`,[hash]);
        if(!found.rowCount)return null;
        const pending=found.rows[0],prefs=cleanCommunicationPreferences(pending.communication_preferences||{});
        const reservation=(await client.query(`SELECT id,plan_id,expires_at,consumed_at,released_at FROM free_access_registration_reservations WHERE pending_registration_id=$1 FOR UPDATE`,[pending.id])).rows[0]||null;
        const banned=await client.query(`SELECT 1 FROM customer_bans WHERE revoked_at IS NULL AND blocks_registration=TRUE AND normalized_email=LOWER(BTRIM($1)) LIMIT 1`,[pending.email]);
        if(banned.rowCount)return terminalize(client,pending.id,'Registration is not available for this email address');
        const exists=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) OR lower(username)=lower($2) LIMIT 1`,[pending.email,pending.username]);
        if(exists.rowCount)return terminalize(client,pending.id,'An account already exists with that email or username');
        try{await assertNoUnclaimedJellyfinUsername(client,pending.username);}catch(error){return terminalize(client,pending.id,error.message);}
        const user=(await client.query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NOW()) RETURNING id,email,username,role,active,email_verified_at,created_at,session_version`,[pending.email,pending.username,pending.password_hash])).rows[0];
        const customer=(await client.query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING *`,[user.id,pending.username,pending.email])).rows[0];
        await client.query(`INSERT INTO customer_communication_preferences(customer_id,phone_e164,whatsapp_opt_in,whatsapp_opted_in_at,telegram_handle,telegram_opt_in,discord_handle,discord_opt_in) VALUES($1,$2,$3,CASE WHEN $3 THEN NOW() ELSE NULL END,$4,$5,$6,$7) ON CONFLICT(customer_id) DO UPDATE SET phone_e164=EXCLUDED.phone_e164,whatsapp_opt_in=EXCLUDED.whatsapp_opt_in,whatsapp_opted_in_at=EXCLUDED.whatsapp_opted_in_at,telegram_handle=EXCLUDED.telegram_handle,telegram_opt_in=EXCLUDED.telegram_opt_in,discord_handle=EXCLUDED.discord_handle,discord_opt_in=EXCLUDED.discord_opt_in,updated_at=NOW()`,[customer.id,prefs.phone_e164,prefs.whatsapp_opt_in,prefs.telegram_handle,prefs.telegram_opt_in,prefs.discord_handle,prefs.discord_opt_in]);
        let referralCodeId=null;if(pending.referral_code&&await referrals.attributionEnabled(client))referralCodeId=await referrals.attributeReferral(customer.id,pending.referral_code,client);
        await client.query(`UPDATE pending_registrations SET consumed_at=NOW(),updated_at=NOW() WHERE id=$1`,[pending.id]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.registration.verified','customer',$2,$3::jsonb)`,[user.id,customer.id,JSON.stringify({pendingRegistrationId:pending.id,emailVerified:true,referralAttributed:Boolean(referralCodeId),freeAccessRequested:Boolean(pending.free_access_requested),freeReservationId:reservation?.id||null,optionalChannels:{whatsapp:prefs.whatsapp_opt_in,telegram:prefs.telegram_opt_in,discord:prefs.discord_opt_in}})]);
        return{user,customer,referralCodeId,pendingRegistrationId:pending.id,freeAccessRequested:Boolean(pending.free_access_requested),freeReservation:reservation};
    });
    if(!created)return null;
    if(created.terminalError)throw new Error(created.terminalError);
    return created;
}

async function cleanupExpired(limit=500){const max=Math.max(1,Math.min(5000,Number(limit)||500)),result=await query(`WITH doomed AS (SELECT id FROM pending_registrations WHERE consumed_at IS NULL AND expires_at<=NOW() ORDER BY expires_at LIMIT $1) DELETE FROM pending_registrations p USING doomed d WHERE p.id=d.id RETURNING p.id`,[max]);return{processed:result.rowCount,removed:result.rowCount};}
async function recent(limit=50){const result=await query(`SELECT id,email,username,expires_at,consumed_at,free_access_requested,created_at FROM pending_registrations ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(200,Number(limit)||50))]);return result.rows;}
async function stats(){const result=await query(`SELECT COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at>NOW())::int pending,COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at<=NOW())::int expired FROM pending_registrations`);return result.rows[0]||{pending:0,expired:0};}
module.exports={FREE_HOLD_MINUTES,begin,consume,cleanupExpired,recent,stats,cleanEmail,cleanUsername,validatePassword,tokenHash,cleanCommunicationPreferences,canonicalFreePlan,assertNoUnclaimedJellyfinUsername};
