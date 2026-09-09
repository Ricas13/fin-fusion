'use strict';
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const {query,transaction}=require('../db');
const customers=require('../customers');
const referrals=require('../referrals');
const planCapacity=require('../entitlements/plan-capacity');

const LOCK_SEED=761931;
// Anonymous browsers get only a short-lived registration intent. It does not
// consume plan capacity. A real capacity reservation is created atomically in
// begin() only after email, username and password have all passed validation.
const FREE_INTENT_MINUTES=10;
// Backward-compatible export for existing views/routes while the wording moves
// from "hold" to "signup window".
const FREE_HOLD_MINUTES=FREE_INTENT_MINUTES;
// Once the customer has verified their email, their reserved Free place becomes
// a durable activation intent. Keep it alive long enough for the short-capacity
// backfill job to retry a transient claim failure without asking the customer to
// register again.
const FREE_POST_VERIFY_RETRY_MINUTES=15;
function cleanEmail(value){const email=String(value||'').trim().toLowerCase();if(!email||!email.includes('@')||email.length>254||/[\r\n<>]/.test(email))throw new Error('A valid email address is required');return email;}
function cleanUsername(value){const username=String(value||'').trim();if(!/^[A-Za-z0-9._-]{3,40}$/.test(username))throw new Error('Username must be 3-40 characters using letters, numbers, dot, underscore or dash');return username;}
async function validatePassword(password){return customers.validateNewPassword(password);}
function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function sessionHash(sessionId){const value=String(sessionId||'').trim();if(!value)throw new Error('A browser session is required to start Free Access signup.');return tokenHash(`free-access-intent:${value}`);}
function refreshFreePlacesStatus(reason='capacity_changed'){
    setImmediate(()=>{
        let digest;
        try{digest=require('../automation/free-places-digest');}catch(error){console.warn(`Free Server Discord refresh load failed (${reason}):`,error.message);return;}
        Promise.resolve(digest.syncPersistent()).catch(error=>console.warn(`Free Server Discord refresh failed (${reason}):`,error.message));
    });
}
function cleanCommunicationPreferences(value={}){
    const telegram=String(value.telegram_handle||value.telegram||'').trim().replace(/^@/,'').slice(0,64);
    const discord=String(value.discord_handle||value.discord||'').trim().slice(0,100);
    return {
        telegram_handle:telegram||null,
        telegram_opt_in:Boolean(value.telegram_opt_in),
        discord_handle:discord||null,
        discord_opt_in:Boolean(value.discord_opt_in)
    };
}
async function serialize(client){await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:pending-registration',$1::bigint))`,[LOCK_SEED]);}
async function assertNoUnclaimedJellyfinUsername(client,username){const conflict=await client.query(`SELECT 1 FROM jellyfin_accounts ja JOIN customers c ON c.id=ja.customer_id WHERE c.user_id IS NULL AND lower(ja.jellyfin_username)=lower($1) LIMIT 1`,[username]);if(conflict.rowCount)throw new Error('That username belongs to an existing Jellyfin account. Use the existing-account claim link instead of creating a new account.');}
async function lockExistingCustomerForRegistration(client,email){
    const matches=await client.query(`SELECT id,user_id,display_name,email FROM customers WHERE lower(BTRIM(COALESCE(email,'')))=lower(BTRIM($1)) ORDER BY created_at ASC,id ASC FOR UPDATE`,[email]);
    if(matches.rowCount>1)return{terminalError:'Multiple customer records already use this email. Please use your existing-account invite or contact support.'};
    const customer=matches.rows[0]||null;
    if(customer?.user_id)return{terminalError:'This customer record already has a portal account. Please sign in or use account recovery.'};
    return{customer};
}
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
function expiredHoldError(){const error=new Error(`Your ${FREE_INTENT_MINUTES}-minute Free Access signup window has expired. Start Free Access signup again to continue.`);error.code='FREE_ACCESS_RESERVATION_EXPIRED';error.status=409;return error;}
function capacityError(error){return error?.code==='PLAN_CAPACITY_EXHAUSTED'||/currently sold out/i.test(String(error?.message||''));}

// Backward-compatible function name: this now creates a non-capacity-holding
// registration intent. The scarce reservation is created only by begin().
async function reserveFreeAccess({sessionId}){
    const holderSessionHash=sessionHash(sessionId);
    try{
        return await transaction(async client=>{
            await serialize(client);
            await client.query(`DELETE FROM free_access_registration_intents WHERE holder_session_hash=$1 AND expires_at<=NOW()`,[holderSessionHash]);
            const plan=await canonicalFreePlan(client);
            if(!plan)throw new Error('Free Access is not available for new claims right now.');
            // This is only a current-availability hint for UX. It does not hold a
            // place; begin() repeats the check under the capacity advisory lock.
            await planCapacity.assertAvailable(plan.id,{db:(sql,params)=>client.query(sql,params),label:plan.name||'Free Access'});
            const expiresAt=new Date(Date.now()+FREE_INTENT_MINUTES*60000);
            const intent=(await client.query(`
                INSERT INTO free_access_registration_intents(holder_session_hash,plan_id,expires_at)
                VALUES($1,$2,$3)
                ON CONFLICT(holder_session_hash,plan_id)
                DO UPDATE SET expires_at=EXCLUDED.expires_at,updated_at=NOW()
                RETURNING id,plan_id,expires_at,created_at
            `,[holderSessionHash,plan.id,expiresAt])).rows[0];
            await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.free_intent_started','free_access_registration_intent',$1,$2::jsonb)`,[intent.id,JSON.stringify({planId:plan.id,expiresAt:intent.expires_at,intentMinutes:FREE_INTENT_MINUTES})]);
            return intent;
        });
    }catch(error){if(capacityError(error))throw noFreePlacesError();throw error;}
}

// Backward-compatible function name for existing route/tests. It now resolves
// the browser's Free registration intent, not a capacity reservation.
async function reservationForSession(intentId,sessionId,db=query){
    if(!intentId||!sessionId)return null;
    const holderSessionHash=sessionHash(sessionId);
    const result=await db(`SELECT id,plan_id,expires_at,created_at FROM free_access_registration_intents WHERE id=$1 AND holder_session_hash=$2 AND expires_at>NOW() LIMIT 1`,[intentId,holderSessionHash]);
    return result.rows[0]||null;
}

async function begin({email,username,password,referralCode=null,communicationPreferences={},ttlMinutes=60,freeAccess=false,freeReservationId=null,freeReservationSessionId=null}){
    email=cleanEmail(email);username=cleanUsername(username);await validatePassword(password);
    const prefs=cleanCommunicationPreferences(communicationPreferences);
    const passwordHash=await bcrypt.hash(password,12),raw=crypto.randomBytes(32).toString('base64url'),hash=tokenHash(raw),minutes=Math.max(10,Math.min(24*60,Number(ttlMinutes)||60)),expiresAt=new Date(Date.now()+minutes*60000),ref=String(referralCode||'').trim().toUpperCase().slice(0,20)||null,holderSessionHash=freeAccess?sessionHash(freeReservationSessionId):null;
    let row;
    try{
        row=await transaction(async client=>{
            await serialize(client);
            const banned=await client.query(`SELECT 1 FROM customer_bans WHERE revoked_at IS NULL AND blocks_registration=TRUE AND normalized_email=LOWER(BTRIM($1)) LIMIT 1`,[email]);
            if(banned.rowCount)throw new Error('Registration is not available for this email address');
            const exists=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) OR lower(username)=lower($2) LIMIT 1`,[email,username]);
            if(exists.rowCount)throw new Error('An account already exists with that email or username');
            await assertNoUnclaimedJellyfinUsername(client,username);

            let freePlan=null,freeIntent=null;
            if(freeAccess){
                if(!freeReservationId)throw expiredHoldError();
                freePlan=await canonicalFreePlan(client);
                if(!freePlan)throw new Error('Free Access is not available for new claims right now.');
                freeIntent=(await client.query(`SELECT id,plan_id,expires_at,created_at FROM free_access_registration_intents WHERE id=$1 AND holder_session_hash=$2 AND expires_at>NOW() FOR UPDATE`,[freeReservationId,holderSessionHash])).rows[0]||null;
                if(!freeIntent||String(freeIntent.plan_id)!==String(freePlan.id))throw expiredHoldError();
            }

            // Re-registering the same identity intentionally replaces the older
            // unverified attempt. Its reservation cascades away before the new
            // capacity check, so the customer does not count twice.
            await client.query(`DELETE FROM pending_registrations WHERE consumed_at IS NULL AND (expires_at<=NOW() OR lower(email)=lower($1) OR lower(username)=lower($2))`,[email,username]);

            if(freePlan){
                await planCapacity.lockAndAssert(client,freePlan.id,freePlan.name||'Free Access');
            }

            const created=await client.query(`INSERT INTO pending_registrations(email,username,password_hash,referral_code,token_hash,expires_at,communication_preferences,free_access_requested) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id,email,username,expires_at,created_at,free_access_requested`,[email,username,passwordHash,ref,hash,expiresAt,JSON.stringify(prefs),Boolean(freeAccess)]);
            let freeReservation=null;
            if(freePlan&&freeIntent){
                freeReservation=(await client.query(`
                    INSERT INTO free_access_registration_reservations(pending_registration_id,plan_id,normalized_email,expires_at,holder_session_hash)
                    VALUES($1,$2,$3,$4,$5)
                    RETURNING id,plan_id,expires_at,pending_registration_id,normalized_email,created_at
                `,[created.rows[0].id,freePlan.id,email,expiresAt,holderSessionHash])).rows[0];
                await client.query(`DELETE FROM free_access_registration_intents WHERE id=$1`,[freeIntent.id]);
                await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.free_reserved','free_access_registration_reservation',$1,$2::jsonb)`,[freeReservation.id,JSON.stringify({planId:freePlan.id,pendingRegistrationId:created.rows[0].id,registrationIntentId:freeIntent.id,expiresAt:freeReservation.expires_at})]);
            }
            await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.registration.pending','pending_registration',$1,$2::jsonb)`,[created.rows[0].id,JSON.stringify({email,username,expiresAt,referral:Boolean(ref),freeAccess:Boolean(freeAccess),freeHoldExpiresAt:freeReservation?.expires_at||null,freeReservationId:freeReservation?.id||null,optionalChannels:{telegram:prefs.telegram_opt_in,discord:prefs.discord_opt_in}})]);
            return{...created.rows[0],freeReservation};
        });
    }catch(error){if(capacityError(error))throw noFreePlacesError();throw error;}
    if(row.freeReservation)refreshFreePlacesStatus('reservation_created');
    return{...row,token:raw};
}

async function consume(rawToken){
    const hash=tokenHash(rawToken),created=await transaction(async client=>{
        await serialize(client);
        const found=await client.query(`SELECT * FROM pending_registrations WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`,[hash]);
        if(!found.rowCount)return null;
        const pending=found.rows[0],prefs=cleanCommunicationPreferences(pending.communication_preferences||{});
        let reservation=(await client.query(`SELECT id,plan_id,expires_at,consumed_at,released_at,customer_id,subscription_id FROM free_access_registration_reservations WHERE pending_registration_id=$1 FOR UPDATE`,[pending.id])).rows[0]||null;
        if(pending.free_access_requested&&(!reservation||reservation.consumed_at||reservation.released_at||new Date(reservation.expires_at).getTime()<=Date.now()))return terminalize(client,pending.id,'Your reserved Free Access place is no longer available. Please start Free Access signup again.');
        const banned=await client.query(`SELECT 1 FROM customer_bans WHERE revoked_at IS NULL AND blocks_registration=TRUE AND normalized_email=LOWER(BTRIM($1)) LIMIT 1`,[pending.email]);
        if(banned.rowCount)return terminalize(client,pending.id,'Registration is not available for this email address');
        const exists=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) OR lower(username)=lower($2) LIMIT 1`,[pending.email,pending.username]);
        if(exists.rowCount)return terminalize(client,pending.id,'An account already exists with that email or username');
        try{await assertNoUnclaimedJellyfinUsername(client,pending.username);}catch(error){return terminalize(client,pending.id,error.message);}
        const existingCustomer=await lockExistingCustomerForRegistration(client,pending.email);
        if(existingCustomer.terminalError)return terminalize(client,pending.id,existingCustomer.terminalError);
        const user=(await client.query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,$3,'customer',NOW()) RETURNING id,email,username,role,active,email_verified_at,created_at,session_version`,[pending.email,pending.username,pending.password_hash])).rows[0];
        let customer;
        if(existingCustomer.customer){
            const linked=await client.query(`UPDATE customers SET user_id=$1,display_name=CASE WHEN NULLIF(BTRIM(COALESCE(display_name,'')),'') IS NULL THEN $2 ELSE display_name END,email=$3 WHERE id=$4 AND user_id IS NULL RETURNING *`,[user.id,pending.username,pending.email,existingCustomer.customer.id]);
            if(!linked.rowCount)throw new Error('Customer portal identity changed while registration was being verified');
            customer=linked.rows[0];
        }else{
            customer=(await client.query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING *`,[user.id,pending.username,pending.email])).rows[0];
        }
        if(pending.free_access_requested){
            reservation=(await client.query(`UPDATE free_access_registration_reservations SET customer_id=$2,expires_at=GREATEST(expires_at,NOW()+($3::int*INTERVAL '1 minute')),updated_at=NOW() WHERE id=$1 AND pending_registration_id=$4 AND consumed_at IS NULL AND released_at IS NULL RETURNING id,plan_id,expires_at,consumed_at,released_at,customer_id,subscription_id`,[reservation.id,customer.id,FREE_POST_VERIFY_RETRY_MINUTES,pending.id])).rows[0]||null;
            if(!reservation)throw new Error('Free Access reservation changed while registration was being verified');
        }
        await client.query(`INSERT INTO customer_communication_preferences(customer_id,telegram_handle,telegram_opt_in,discord_handle,discord_opt_in) VALUES($1,$2,$3,$4,$5) ON CONFLICT(customer_id) DO UPDATE SET telegram_handle=EXCLUDED.telegram_handle,telegram_opt_in=EXCLUDED.telegram_opt_in,discord_handle=EXCLUDED.discord_handle,discord_opt_in=EXCLUDED.discord_opt_in,updated_at=NOW()`,[customer.id,prefs.telegram_handle,prefs.telegram_opt_in,prefs.discord_handle,prefs.discord_opt_in]);
        let referralCodeId=null;if(pending.referral_code&&await referrals.attributionEnabled(client))referralCodeId=await referrals.attributeReferral(customer.id,pending.referral_code,client);
        await client.query(`UPDATE pending_registrations SET consumed_at=NOW(),updated_at=NOW() WHERE id=$1`,[pending.id]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.registration.verified','customer',$2,$3::jsonb)`,[user.id,customer.id,JSON.stringify({pendingRegistrationId:pending.id,emailVerified:true,linkedExistingCustomer:Boolean(existingCustomer.customer),referralAttributed:Boolean(referralCodeId),freeAccessRequested:Boolean(pending.free_access_requested),freeReservationId:reservation?.id||null,freeRetryUntil:reservation?.expires_at||null,optionalChannels:{telegram:prefs.telegram_opt_in,discord:prefs.discord_opt_in}})]);
        return{user,customer,referralCodeId,pendingRegistrationId:pending.id,freeAccessRequested:Boolean(pending.free_access_requested),freeReservation:reservation};
    });
    if(!created)return null;
    if(created.terminalError){refreshFreePlacesStatus('reservation_released');throw new Error(created.terminalError);}
    return created;
}

async function cleanupExpired(limit=500){
    const max=Math.max(1,Math.min(5000,Number(limit)||500));
    const expiredIntents=await query(`WITH doomed AS (SELECT id FROM free_access_registration_intents WHERE expires_at<=NOW() ORDER BY expires_at LIMIT $1) DELETE FROM free_access_registration_intents i USING doomed d WHERE i.id=d.id RETURNING i.id`,[max]);
    const released=await query(`UPDATE free_access_registration_reservations SET released_at=COALESCE(released_at,NOW()),updated_at=NOW() WHERE consumed_at IS NULL AND released_at IS NULL AND expires_at<=NOW() RETURNING id`);
    const result=await query(`WITH doomed AS (SELECT id FROM pending_registrations WHERE consumed_at IS NULL AND expires_at<=NOW() ORDER BY expires_at LIMIT $1) DELETE FROM pending_registrations p USING doomed d WHERE p.id=d.id RETURNING p.id`,[max]);
    if(released.rowCount)refreshFreePlacesStatus('reservation_expired');
    return{processed:result.rowCount,removed:result.rowCount,releasedReservations:released.rowCount,expiredIntents:expiredIntents.rowCount};
}
async function recent(limit=50){const result=await query(`SELECT id,email,username,expires_at,consumed_at,free_access_requested,created_at FROM pending_registrations ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(200,Number(limit)||50))]);return result.rows;}
async function stats(){const result=await query(`SELECT COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at>NOW())::int pending,COUNT(*) FILTER(WHERE consumed_at IS NULL AND expires_at<=NOW())::int expired FROM pending_registrations`);return result.rows[0]||{pending:0,expired:0};}
module.exports={FREE_INTENT_MINUTES,FREE_HOLD_MINUTES,FREE_POST_VERIFY_RETRY_MINUTES,begin,consume,reserveFreeAccess,reservationForSession,cleanupExpired,recent,stats,cleanEmail,cleanUsername,validatePassword,tokenHash,sessionHash,cleanCommunicationPreferences,canonicalFreePlan,assertNoUnclaimedJellyfinUsername,lockExistingCustomerForRegistration,refreshFreePlacesStatus};