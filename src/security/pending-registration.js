'use strict';
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const {query,transaction}=require('../db');
const customers=require('../customers');
const referrals=require('../referrals');
const planCapacity=require('../entitlements/plan-capacity');

const LOCK_SEED=761931;
const FREE_HOLD_MINUTES=10;
function cleanEmail(value){const email=String(value||'').trim().toLowerCase();if(!email||!email.includes('@')||email.length>254||/[\r\n<>]/.test(email))throw new Error('A valid email address is required');return email;}
function cleanUsername(value){const username=String(value||'').trim();if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))throw new Error('Username must be 3-40 characters using letters, numbers, dot, underscore or dash');return username;}
async function validatePassword(password){return customers.validateNewPassword(password);}
function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function sessionHash(sessionId){const value=String(sessionId||'').trim();if(!value)throw new Error('A browser session is required to reserve Free Access.');return tokenHash(`free-access-hold:${value}`);}
function refreshFreePlacesStatus(reason='capacity_changed'){
    setImmediate(()=>{
        let digest;
        try{digest=require('../automation/free-places-digest');}catch(error){console.warn(`Free Server Discord refresh load failed (${reason}):`,error.message);return;}
        Promise.resolve(digest.syncPersistent()).catch(error=>console.warn(`Free Server Discord refresh failed (${reason}):`,error.message));
    });
}
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
    await client.query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()),updated_at=NOW() WHERE pending_registration_id=$1 AND consumed_at IS NULL AND released_at IS NULL`,[pendingId]);
    return{terminalError:message};
}
async function canonicalFreePlan(client){
    const found=await client.query(`SELECT id,code,name,capacity_limit FROM plans WHERE active=TRUE AND visible=TRUE AND is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE AND audience IN('direct','both') AND price_minor=0 AND billing_interval<>'trial' AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY sort_order ASC,id ASC LIMIT 1`);
    return found.rows[0]||null;
}
function noFreePlacesError(){const error=new Error('No free places currently available');error.code='FREE_ACCESS_CAPACITY_EXHAUSTED';error.status=409;return error;}
function expiredHoldError(){const error=new Error(`Your ${FREE_HOLD_MINUTES}-minute Free Access reservation has expired. Reserve a new place to continue.`);error.code='FREE_ACCESS_RESERVATION_EXPIRED';error.status=409;return error;}
async function reserveFreeAccess({sessionId}){
    const holderSessionHash=sessionHash(sessionId);
    try{
        const reservation=await transaction(async client=>{
            await serialize(client);
            await client.query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()),updated_at=NOW() WHERE holder_session_hash=$1 AND consumed_at IS NULL AND released_at IS NULL AND expires_at<=NOW()`,[holderSessionHash]);
            const plan=await canonicalFreePlan(client);
            if(!plan)throw new Error('Free Access is not available for new claims right now.');
            const existing=await client.query(`SELECT id,plan_id,expires_at,pending_registration_id,normalized_email,created_at FROM free_access_registration_reservations WHERE holder_session_hash=$1 AND plan_id=$2 AND consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[holderSessionHash,plan.id]);
            if(existing.rowCount)return existing.rows[0];
            await client.query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()),updated_at=NOW() WHERE holder_session_hash=$1 AND consumed_at IS NULL AND released_at IS NULL`,[holderSessionHash]);
            await planCapacity.lockAndAssert(client,plan.id,plan.name||'Free Access');
            const expiresAt=new Date(Date.now()+FREE_HOLD_MINUTES*60000);
            const created=(await client.query(`INSERT INTO free_access_registration_reservations(pending_registration_id,plan_id,normalized_email,expires_at,holder_session_hash) VALUES(NULL,$1,NULL,$2,$3) RETURNING id,plan_id,expires_at,pending_registration_id,normalized_email,created_at`,[plan.id,expiresAt,holderSessionHash])).rows[0];
            await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.free_reserved','free_access_registration_reservation',$1,$2::jsonb)`,[created.id,JSON.stringify({planId:plan.id,expiresAt:created.expires_at,holdMinutes:FREE_HOLD_MINUTES})]);
            return created;
        });
        refreshFreePlacesStatus('reservation_created');
        return reservation;
    }catch(error){if(error?.code==='PLAN_CAPACITY_EXHAUSTED'||/currently sold out/i.test(String(error?.message||'')))throw noFreePlacesError();throw error;}
}
async function reservationForSession(reservationId,sessionId,db=query){
    if(!reservationId||!sessionId)return null;
    const holderSessionHash=sessionHash(sessionId);
    const result=await db(`SELECT id,plan_id,expires_at,pending_registration_id,normalized_email,created_at FROM free_access_registration_reservations WHERE id=$1 AND holder_session_hash=$2 AND consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW() LIMIT 1`,[reservationId,holderSessionHash]);
    return result.rows[0]||null;
}

async function begin({email,username,password,referralCode=null,communicationPreferences={},ttlMinutes=60,freeAccess=false,freeReservationId=null,freeReservationSessionId=null}){
    email=cleanEmail(email);username=cleanUsername(username);await validatePassword(password);
    const prefs=cleanCommunicationPreferences(communicationPreferences);
    const passwordHash=await bcrypt.hash(password,12),raw=crypto.randomBytes(32).toString('base64url'),hash=tokenHash(raw),minutes=Math.max(10,Math.min(24*60,Number(ttlMinutes)||60)),expiresAt=new Date(Date.now()+minutes*60000),ref=String(referralCode||'').trim().toUpperCase().slice(0,20)||null,holderSessionHash=freeAccess?sessionHash(freeReservationSessionId):null;
    const row=await transaction(async client=>{
        await serialize(client);
        const banned=await client.query(`SELECT 1 FROM customer_bans WHERE revoked_at IS NULL AND blocks_registration=TRUE AND normalized_email=LOWER(BTRIM($1)) LIMIT 1`,[email]);
        if(banned.rowCount)throw new Error('Registration is not available for this email address');
        const exists=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) OR lower(username)=lower($2) LIMIT 1`,[email,username]);
        if(exists.rowCount)throw new Error('An account already exists with that email or username');
        await assertNoUnclaimedJellyfinUsername(client,username);
        let freeReservation=null;
        if(freeAccess){
            if(!freeReservationId)throw expiredHoldError();
            const plan=await canonicalFreePlan(client);
            if(!plan)throw new Error('Free Access is not available for new claims right now.');
            freeReservation=(await client.query(`SELECT id,plan_id,expires_at,pending_registration_id,normalized_email FROM free_access_registration_reservations WHERE id=$1 AND holder_session_hash=$2 AND consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW() FOR UPDATE`,[freeReservationId,holderSessionHash])).rows[0]||null;
            if(!freeReservation||String(freeReservation.plan_id)!==String(plan.id))throw expiredHoldError();
            if(freeReservation.pending_registration_id)await client.query(`UPDATE free_access_registration_reservations SET pending_registration_id=NULL,normalized_email=NULL,updated_at=NOW() WHERE id=$1`,[freeReservation.id]);
        }
        await client.query(`DELETE FROM pending_registrations WHERE consumed_at IS NULL AND (expires_at<=NOW() OR lower(email)=lower($1) OR lower(username)=lower($2))`,[email,username]);
        const created=await client.query(`INSERT INTO pending_registrations(email,username,password_hash,referral_code,token_hash,expires_at,communication_preferences,free_access_requested) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id,email,username,expires_at,created_at,free_access_requested`,[email,username,passwordHash,ref,hash,expiresAt,JSON.stringify(prefs),Boolean(freeAccess)]);
        if(freeReservation){
            freeReservation=(await client.query(`UPDATE free_access_registration_reservations SET pending_registration_id=$2,normalized_email=$3,updated_at=NOW() WHERE id=$1 RETURNING id,plan_id,expires_at,pending_registration_id,normalized_email`,[freeReservation.id,created.rows[0].id,email])).rows[0];
        }
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.pending','pending_registration',$1,$2::jsonb)`,[created.rows[0].id,JSON.stringify({email,username,expiresAt,referral:Boolean(ref),freeAccess:Boolean(freeAccess),freeHoldExpiresAt:freeReservation?.expires_at||null,freeReservationId:freeReservation?.id||null,optionalChannels:{whatsapp:prefs.whatsapp_opt_in,telegram:prefs.telegram_opt_in,discord:prefs.discord_opt_in}})]);
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
    if(created.terminalError){refreshFreePlacesStatus('reservation_released');throw new Error(created.terminalError);}
    return created;
}

async function cleanupExpired(limit=500){
    const max=Math.max(1,Math.min(5000,Number(limit)||500));
    const released=await query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()),updated_at=NOW() WHERE consumed_at IS NULL AND released_at IS NULL AND expires_at<=NOW() RETURNING id`);
    const result=await query(`WITH doomed AS (SELECT id FROM pending_registrations WHERE consumed_at IS NULL AND expires_at<=NOW() ORDER BY expires_at LIMIT $1) DELETE FROM pending_registrations p USING doomed d WHERE p.id=d.id RETURNING p.id`,[max]);
    if(released.rowCount)refreshFreePlacesStatus('reservation_expired');
    return{processed:result.rowCount,removed:result.rowCount,releasedReservations:released.rowCount};
}
async function recent(limit=50){const result=await query(`SELECT id,email,username,expires_at,consumed_at,free_access_requested,created_at FROM pending_registrations ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(200,Number(limit)||50))]);return result.rows;}
async function stats(){const result=await query(`SELECT COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at>NOW())::int pending,COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at<=NOW())::int expired FROM pending_registrations`);return result.rows[0]||{pending:0,expired:0};}
module.exports={FREE_HOLD_MINUTES,begin,consume,reserveFreeAccess,reservationForSession,cleanupExpired,recent,stats,cleanEmail,cleanUsername,validatePassword,tokenHash,sessionHash,cleanCommunicationPreferences,canonicalFreePlan,assertNoUnclaimedJellyfinUsername,refreshFreePlacesStatus};