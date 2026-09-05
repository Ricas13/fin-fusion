'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const provisioning=require('../jellyfin/resilient-provisioning');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}

async function rows(search='',customerId=''){
    const value=String(search||'').trim().slice(0,120),needle=`%${value}%`,id=String(customerId||'').trim();
    return (await query(`SELECT ja.id account_id,ja.customer_id,ja.jellyfin_username,ja.disabled,ja.password_setup_required,js.name server_name,js.server_class,c.display_name,u.username portal_username,u.email portal_email
      FROM jellyfin_accounts ja
      JOIN customers c ON c.id=ja.customer_id
      JOIN app_users u ON u.id=c.user_id
      JOIN jellyfin_servers js ON js.id=ja.server_id
      WHERE ja.account_purpose<>'stremio_internal'
        AND ($3='' OR c.id::text=$3)
        AND ($1='' OR u.username ILIKE $2 OR COALESCE(u.email,'') ILIKE $2 OR COALESCE(c.display_name,'') ILIKE $2 OR ja.jellyfin_username ILIKE $2)
      ORDER BY COALESCE(c.display_name,u.username,u.email),ja.is_primary DESC,js.name
      LIMIT 100`,[value,needle,id])).rows;
}

function body(req,accounts,search,customerId){
    const cards=accounts.map(a=>`<article class="profileCard"><div class="profileCardHead"><div><h2>${esc(a.display_name||a.portal_username||a.portal_email||'Customer')}</h2><div class="muted">Portal: ${esc(a.portal_username||a.portal_email||'—')} · Jellyfin: <strong>${esc(a.jellyfin_username)}</strong> · ${esc(a.server_name)}</div></div><span class="pill ${a.disabled?'bad':'good'}">${a.disabled?'Disabled':'Enabled'}</span></div><div class="profileCardBody"><p class="subText">Set a new Jellyfin password for this account. The password is sent directly to Jellyfin and is never stored in the audit log.</p><form class="formPanel" method="post" action="/admin/customer-jellyfin-password/${encodeURIComponent(a.customer_id)}/${encodeURIComponent(a.account_id)}">${token(req)}<div class="formGrid"><div class="formGroup"><label>New Jellyfin password</label><input class="input" type="password" name="password" minlength="8" maxlength="200" autocomplete="new-password" required></div><div class="formGroup"><label>Confirm password</label><input class="input" type="password" name="confirmPassword" minlength="8" maxlength="200" autocomplete="new-password" required></div></div><button class="button">Change Jellyfin password</button></form></div></article>`).join('');
    const back=customerId?`<a class="button secondary" href="/admin/users/${encodeURIComponent(customerId)}?tab=access">Back to customer</a>`:'';
    return `${notice(req)}<section class="section"><div class="sectionHead"><div><h2>Jellyfin password support</h2><div class="muted">Administrator-assisted password change for a customer who cannot complete it themselves.</div></div>${back}</div>${customerId?'':`<form class="formPanel" method="get" action="/admin/customer-jellyfin-password"><div class="formGrid"><div class="formGroup"><label>Find customer</label><input class="input" name="q" maxlength="120" value="${esc(search)}" placeholder="Portal username, email, display name or Jellyfin username"></div></div><button class="button secondary">Search</button></form>`}</section><section class="section"><div class="sectionHead"><h2>Jellyfin accounts</h2><span class="muted">${accounts.length} shown</span></div>${accounts.length?`<div class="profileGrid">${cards}</div>`:'<div class="empty">No matching Jellyfin accounts.</div>'}</section>`;
}

function createAdminCustomerJellyfinPasswordRouter(){
    const router=express.Router();
    router.use('/admin/customer-jellyfin-password',gate,noStore);
    router.get('/admin/customer-jellyfin-password',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const search=String(req.query.q||'').trim().slice(0,120),customerId=String(req.query.customerId||'').trim(),accounts=await rows(search,customerId);return res.send(layout({siteName:runtimeSettings.siteName(),active:'users',title:'Jellyfin Password Support',subtitle:'Customer support action',body:body(req,accounts,search,customerId)}));}catch(error){return next(error)}});
    router.post('/admin/customer-jellyfin-password/:customerId/:accountId',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        const password=String(req.body.password||''),confirm=String(req.body.confirmPassword||'');
        const supportPath=`/admin/customer-jellyfin-password?customerId=${encodeURIComponent(req.params.customerId)}`;
        if(password.length<8||password.length>200)return res.redirect(supportPath+'&error='+encodeURIComponent('Jellyfin password must be between 8 and 200 characters.'));
        if(password!==confirm)return res.redirect(supportPath+'&error='+encodeURIComponent('Jellyfin passwords do not match.'));
        try{
            const owned=await query(`SELECT 1 FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2 AND account_purpose<>'stremio_internal'`,[req.params.accountId,req.params.customerId]);
            if(!owned.rowCount)throw new Error('Jellyfin account not found for this customer.');
            await provisioning.setJellyfinPassword(req.params.customerId,req.params.accountId,password);
            await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,updated_at=NOW() WHERE id=$1 AND customer_id=$2`,[req.params.accountId,req.params.customerId]);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.jellyfin_password.change','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({accountId:req.params.accountId})]);
            return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}?tab=access&message=${encodeURIComponent('Jellyfin password changed.')}`);
        }catch(error){return res.redirect(supportPath+'&error='+encodeURIComponent(error.message||'Jellyfin password could not be changed.'));}
    });
    return router;
}

module.exports={createAdminCustomerJellyfinPasswordRouter,rows,body};
