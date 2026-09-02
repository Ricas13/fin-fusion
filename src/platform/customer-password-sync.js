'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const requestUsers=require('../integrations/request-user-sync');
const routeRateLimit=require('../security/route-rate-limit');
const {createCustomerNowPlayingRouter}=require('./customer-now-playing');

const mediaPasswordLimit=routeRateLimit.middleware({scope:'customer-media-password',max:10,windowSeconds:900});
const requestPasswordLimit=routeRateLimit.middleware({scope:'customer-request-password',max:10,windowSeconds:900});

function requireCustomer(req,res,next){
    if(req.session?.customerId&&req.session?.customerUserId)return next();
    return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));
}
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function mediaType(account){return String(account?.media_server_type||'jellyfin').toLowerCase()==='emby'?'emby':'jellyfin';}
function mediaLabel(account){return mediaType(account)==='emby'?'Emby':'Jellyfin';}

async function mediaRows(customerId){
    const result=await query(`
      SELECT ja.id,ja.customer_id,ja.jellyfin_username,ja.access_lane,ja.disabled,
             ja.password_setup_required,ja.password_reset_required,ja.account_purpose,
             js.name AS server_name,js.public_url,js.enabled AS server_enabled,
             COALESCE(js.media_server_type,'jellyfin') AS media_server_type
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      WHERE ja.customer_id=$1 AND ja.account_purpose<>'stremio_internal'
      ORDER BY CASE COALESCE(js.media_server_type,'jellyfin') WHEN 'jellyfin' THEN 0 ELSE 1 END,
               ja.is_primary DESC,ja.created_at
    `,[customerId]);
    return result.rows;
}

async function entitlementSnapshot(customerId){
    const [primary,free,emby]=await Promise.all([
        subscriptionState.effectiveSubscription(customerId),
        subscriptionState.liveFreeJellyfinSubscription(customerId),
        subscriptionState.effectiveEmbySubscription(customerId)
    ]);
    return{primary,free,emby};
}

function entitlementForMediaAccount(account,entitlements){
    if(!account||account.disabled||!account.server_enabled)return null;
    if(mediaType(account)==='emby')return entitlements.emby||null;
    if(String(account.access_lane||'primary')==='free')return entitlements.free||null;
    return entitlements.primary&&!entitlements.primary.is_free_tier?entitlements.primary:null;
}

async function activeMediaAccounts(customerId){
    const [accounts,entitlements]=await Promise.all([mediaRows(customerId),entitlementSnapshot(customerId)]);
    return accounts.filter(account=>Boolean(entitlementForMediaAccount(account,entitlements)));
}

async function assertMediaPasswordAccess(customerId,accountId){
    const [accounts,entitlements]=await Promise.all([mediaRows(customerId),entitlementSnapshot(customerId)]);
    const account=accounts.find(row=>String(row.id)===String(accountId));
    if(!account)throw new Error('Streaming account not found.');
    const entitlement=entitlementForMediaAccount(account,entitlements);
    if(!entitlement)throw new Error(`${mediaLabel(account)} password management requires current ${mediaLabel(account)} access.`);
    return{account,entitlement,serviceType:mediaType(account),label:mediaLabel(account)};
}

async function servicePasswordState(customerId){
    const [accounts,entitlements,requestAccess,requestConfig]=await Promise.all([
        mediaRows(customerId),entitlementSnapshot(customerId),requestUsers.requestAccessForCustomer(customerId),requestUsers.configuration()
    ]);
    return{
        mediaAccounts:accounts.filter(account=>Boolean(entitlementForMediaAccount(account,entitlements))),
        requestAccess,
        requestConfig,
        requestEligible:Boolean(requestConfig?.configured&&requestAccess?.entitlement_active)
    };
}

async function pending(customerId){
    return (await activeMediaAccounts(customerId)).filter(account=>account.password_setup_required);
}

function passwordForm(req,{action,label,button}){
    return `<form method="post" action="${esc(action)}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="field"><label>New ${esc(label)} password</label><input class="input" type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" required></div><div class="field"><label>Confirm password</label><input class="input" type="password" name="confirmPassword" minlength="12" maxlength="200" autocomplete="new-password" required></div><button class="button primary" type="submit">${esc(button)}</button></form>`;
}

function servicePasswordFragment(req,state){
    const mediaCards=state.mediaAccounts.map((account,index)=>{
        const label=mediaLabel(account),anchor=index===0||!state.mediaAccounts.slice(0,index).some(a=>mediaType(a)===mediaType(account))?` id="${mediaType(account)}"`:'';
        const setup=Boolean(account.password_setup_required);
        return `<section class="panel"${anchor}><div class="eyebrow">${esc(label)} password</div><h2>${esc(account.jellyfin_username||label)}</h2><p class="accessMeta">${esc(account.server_name||`${label} server`)}</p><p>${setup?`Choose the password for this ${label} account before you sign in.`:`Reset this ${label} password whenever you need to.`} This password is separate from your CAPTAiNFiN portal password.</p>${account.public_url?`<p><a class="button secondary small" href="${esc(account.public_url)}" target="_blank" rel="noreferrer">Open ${esc(label)} ↗</a></p>`:''}${passwordForm(req,{action:`/account/jellyfin/${encodeURIComponent(account.id)}/password`,label,button:setup?`Set ${label} password`:`Reset ${label} password`})}</section>`;
    }).join('');
    const requestCard=state.requestEligible?`<section class="panel" id="overseerr"><div class="eyebrow">Overseerr password</div><h2>Request content</h2><p>${state.requestAccess?.external_user_id?'Reset your Overseerr password whenever you need to.':'Your plan includes request access. Choose an Overseerr password to create your request account.'} This password is separate from your CAPTAiNFiN portal password.</p>${state.requestConfig?.baseUrl&&state.requestAccess?.external_user_id&&!state.requestAccess?.access_suspended?`<p><a class="button secondary small" href="${esc(state.requestConfig.baseUrl)}" target="_blank" rel="noreferrer">Open Overseerr ↗</a></p>`:''}${passwordForm(req,{action:'/account/requests/password',label:'Overseerr',button:state.requestAccess?.external_user_id?'Reset Overseerr password':'Create Overseerr account'})}</section>`:'';
    if(!mediaCards&&!requestCard)return'';
    return `<section class="servicePasswordBlock" id="service-passwords"><div class="servicePasswordHeading"><div class="eyebrow">Credentials</div><h2>Service passwords</h2><p>Jellyfin, Emby and Overseerr passwords are independent from your portal password and from each other.</p></div><div class="servicePasswordGrid">${mediaCards}${requestCard}</div></section>`;
}

function redirectWith(res,path,key,value,hash=''){return res.redirect(`${path}?${key}=${encodeURIComponent(value)}${hash?`#${encodeURIComponent(hash)}`:''}`);}

function createCustomerPasswordSyncRouter(){
    const router=express.Router();
    router.use(createCustomerNowPlayingRouter());

    // Freshly provisioned MediaBrowser identities use random bootstrap secrets.
    // Keep the setup guard, but send customers to the matching Account section.
    router.use('/account',(req,res,next)=>{
        if(req.method!=='GET'||req.path!=='/')return next();
        return requireCustomer(req,res,async()=>{try{const accounts=await pending(req.session.customerId);if(!accounts.length)return next();return res.redirect('/account/security#service-passwords');}catch(error){return next(error)}});
    });

    router.get('/account/service-passwords/fragment',requireCustomer,async(req,res,next)=>{
        try{
            res.setHeader('Cache-Control','no-store, private, max-age=0');
            const html=servicePasswordFragment(req,await servicePasswordState(req.session.customerId));
            if(!html)return res.status(204).end();
            return res.type('html').send(html);
        }catch(error){return next(error);}
    });
    router.get('/account/service-passwords',requireCustomer,(_req,res)=>res.redirect(302,'/account/security#service-passwords'));
    router.get('/account/jellyfin/setup',requireCustomer,(_req,res)=>res.redirect(302,'/account/security#service-passwords'));
    router.get('/account/requests/password',requireCustomer,(_req,res)=>res.redirect(302,'/account/security#overseerr'));

    router.post('/account/jellyfin/:accountId/password',requireCustomer,mediaPasswordLimit,async(req,res)=>{
        if(!csrf.verify(req))return redirectWith(res,'/account/security','error','Invalid or expired security token','service-passwords');
        const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
        if(password.length<12||password.length>200)return redirectWith(res,'/account/security','error','Streaming-service passwords must be between 12 and 200 characters.','service-passwords');
        if(password!==confirm)return redirectWith(res,'/account/security','error','Passwords do not match.','service-passwords');
        try{
            const access=await assertMediaPasswordAccess(req.session.customerId,req.params.accountId);
            await provisioning.setJellyfinPassword(req.session.customerId,req.params.accountId,password);
            await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,password_reset_required=FALSE,updated_at=NOW() WHERE id=$1 AND customer_id=$2`,[req.params.accountId,req.session.customerId]);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.media_password.change','customer',$2,$3::jsonb)`,[req.session.customerUserId,req.session.customerId,JSON.stringify({accountId:req.params.accountId,serviceType:access.serviceType,secretStored:false})]).catch(()=>{});
            return redirectWith(res,'/account/security','message',`${access.label} password updated.`,'service-passwords');
        }catch(error){return redirectWith(res,'/account/security','error',error.message||'Streaming-service password could not be updated.','service-passwords');}
    });

    router.post('/account/jellyfin/:accountId/username',requireCustomer,mediaPasswordLimit,async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            const access=await assertMediaPasswordAccess(req.session.customerId,req.params.accountId);
            await provisioning.renameJellyfinAccount(req.session.customerId,req.params.accountId,req.body.username,{actorUserId:req.session.customerUserId});
            return res.redirect('/account?message='+encodeURIComponent(`${access.label} username updated. Your watched history and profile stay with the same account.`));
        }catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message||'Streaming username could not be updated.'));}
    });

    router.post('/account/requests/password',requireCustomer,requestPasswordLimit,async(req,res)=>{
        if(!csrf.verify(req))return redirectWith(res,'/account/security','error','Invalid or expired security token','overseerr');
        const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
        if(password.length<12||password.length>200)return redirectWith(res,'/account/security','error','Overseerr password must be between 12 and 200 characters.','overseerr');
        if(password!==confirm)return redirectWith(res,'/account/security','error','Overseerr passwords do not match.','overseerr');
        try{
            const access=await requestUsers.requestAccessForCustomer(req.session.customerId);
            if(!access?.entitlement_active)throw new Error('Overseerr password management requires an active plan or trial.');
            await requestUsers.setCustomerPassword(req.session.customerId,password);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.request_password.change','customer',$2,'{"secretStored":false}'::jsonb)`,[req.session.customerUserId,req.session.customerId]).catch(()=>{});
            return redirectWith(res,'/account/security','message','Overseerr password updated.','overseerr');
        }catch(error){return redirectWith(res,'/account/security','error',error.message||'Overseerr password could not be updated.','overseerr');}
    });

    // Old portal-password-sync forms/bookmarks must never re-couple credentials.
    router.post('/account/requests/password/sync',requireCustomer,requestPasswordLimit,async(req,res)=>{
        if(!csrf.verify(req))return redirectWith(res,'/account/security','error','Invalid or expired security token','overseerr');
        return redirectWith(res,'/account/security','message','Portal and Overseerr passwords are separate. Choose the Overseerr password you want here.','overseerr');
    });

    return router;
}

module.exports={createCustomerPasswordSyncRouter,pending,mediaRows,entitlementSnapshot,entitlementForMediaAccount,activeMediaAccounts,assertMediaPasswordAccess,servicePasswordState,servicePasswordFragment};
