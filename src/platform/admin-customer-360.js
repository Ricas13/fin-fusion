'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const {customer360,customerAccessDetail}=require('./customer-360');
const view=require('./customer-360-view');
const {layout,esc}=require('./admin-html');
const runtimeSettings=require('./runtime-settings');
const provisioning=require('../jellyfin/provisioning');
const policy=require('../jellyfin/policy');

const TABS=new Set(view.TABS.map(x=>x[0]));
function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function text(v,max){return String(v||'').trim().slice(0,max)}
function bool(v){return v==='on'||v==='true'||v===true}
function tags(v){return [...new Set(String(v||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean).map(x=>x.slice(0,40)))].slice(0,20)}
function path(id,tab='overview'){return `/admin/users/${encodeURIComponent(id)}?tab=${encodeURIComponent(tab)}`}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function dt(v){return v?new Date(v).toLocaleString('en-GB'):'—'}
function incidentPanel(rows){return `<section class="section"><div class="sectionHead"><div><h2>Payment incidents</h2><div class="muted">Provider disputes, refunds, chargebacks and failed-renewal cases linked to this customer.</div></div><a class="button secondary" href="/admin/commerce">Open Commerce</a></div>${rows.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>When</th><th>Provider</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(dt(r.created_at))}</td><td>${esc(r.provider)}</td><td>${esc(r.incident_type)}</td><td><span class="pill ${r.resolved_at?'good':'warn'}">${esc(r.incident_status||'open')}</span></td><td><a class="button secondary btn-sm" href="/admin/commerce?incident=${encodeURIComponent(r.id)}#incident-${encodeURIComponent(r.id)}">Open incident</a></td></tr>`).join('')}</tbody></table></div>`:'<div class="emptyCompact">No payment incidents for this customer.</div>'}</section>`;}

function editBody(req,d){const c=d.customer;return `${notice(req)}<section class="section"><div class="sectionHead"><h2>Customer profile</h2><span class="muted">Portal username/email are managed by authentication, not here.</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(c.id)}/profile"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Display name</label><input class="input" name="displayName" maxlength="100" value="${esc(c.display_name||'')}"></div><div class="formGroup"><label>Phone</label><input class="input" name="phone" maxlength="40" value="${esc(c.phone||'')}"></div><div class="formGroup"><label>Country code</label><input class="input" name="countryCode" maxlength="2" placeholder="GB" value="${esc(c.country_code||'')}"></div><div class="formGroup"><label>Timezone</label><input class="input" name="timezone" maxlength="80" placeholder="Europe/London" value="${esc(c.timezone||'')}"></div><div class="formGroup"><label>Discord user ID</label><input class="input" name="discordUserId" inputmode="numeric" maxlength="32" value="${esc(c.discord_user_id||'')}"></div><div class="formGroup"><label>Discord username</label><input class="input" name="discordUsername" maxlength="100" value="${esc(c.discord_username||'')}"></div><div class="formGroup"><label>Referral source</label><input class="input" name="referralSource" maxlength="120" value="${esc(c.referral_source||'')}"></div><div class="formGroup"><label>Registration source</label><input class="input" name="registrationSource" maxlength="40" placeholder="self / admin / reseller" value="${esc(c.registration_source||'')}"></div></div><div class="formGroup"><label>Tags</label><input class="input" name="tags" maxlength="500" placeholder="VIP, support, beta" value="${esc((c.tags||[]).join(', '))}"></div><label class="toggleRow"><input type="checkbox" name="marketingOptIn" ${c.marketing_opt_in?'checked':''}><span>Marketing opt-in</span></label><div class="formGroup"><label>Admin notes</label><textarea class="input" name="note" maxlength="2000">${esc(c.note||'')}</textarea></div><div class="buttonRow"><button class="button">Save profile</button><a class="button secondary" href="${path(c.id)}">Cancel</a></div></form></section>`}

function createAdminCustomer360Router(){
    const router=express.Router();
    router.use('/admin/users',gate,noStore);

    router.get('/admin/users/:customerId/edit-profile',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const d=await customer360(req.params.customerId);if(!d)return res.status(404).send('Customer not found');return res.send(layout({siteName:runtimeSettings.siteName(),active:'users',title:'Edit customer',subtitle:d.customer.display_name||d.customer.login_username||d.customer.login_email||'Managed customer',body:editBody(req,d),action:`<a class="button secondary" href="${path(req.params.customerId)}">Back</a>`}))}catch(error){return next(error)}});

    router.get('/admin/users/:customerId',async(req,res,next)=>{
        try{
            await runtimeSettings.ensureLoaded();
            const detail=await customer360(req.params.customerId);
            if(!detail)return res.status(404).render('auth/message',{siteName:runtimeSettings.siteName(),title:'Customer not found',message:'This managed customer does not exist.',link:'/admin/users',linkText:'Back to Customers'});
            const activeTab=TABS.has(String(req.query.tab||''))?String(req.query.tab):'overview';
            const id=encodeURIComponent(req.params.customerId);
            const [accessDetail,incidentRows]=await Promise.all([activeTab==='access'?customerAccessDetail(req.params.customerId):null,activeTab==='billing'?query(`SELECT id,provider,incident_type,incident_status,created_at,resolved_at FROM payment_incidents WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.params.customerId]):Promise.resolve({rows:[]})]);
            const resellerLink=detail.customer.reseller_id?`<a class="button secondary" href="/admin/reseller-management/${encodeURIComponent(detail.customer.reseller_id)}">Reseller 360 · ${esc(detail.customer.reseller_username||'owner')}</a>`:'';
            const extras=activeTab==='billing'?incidentPanel(incidentRows.rows):'';
            return res.send(layout({siteName:runtimeSettings.siteName(),active:'users',title:'Customer',subtitle:'Registration, subscription, access and usage',body:`${notice(req)}${view.body(detail,activeTab,csrf.token(req),accessDetail)}${extras}`,action:`<div class="buttonRow">${resellerLink}<a class="button secondary" href="${path(req.params.customerId,'activity')}">Activity</a><a class="button secondary" href="/admin/preview/customer/${id}" target="_blank" rel="noopener noreferrer">Preview customer portal</a><a class="button secondary" href="/admin/users">Back to Customers</a></div>`}));
        }catch(error){return next(error)}
    });

    router.post('/admin/users/:customerId/profile',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            const displayName=text(req.body.displayName,100)||null,phone=text(req.body.phone,40)||null,country=text(req.body.countryCode,2).toUpperCase();
            if(country&&!/^[A-Z]{2}$/.test(country))throw new Error('validation');
            const timezone=text(req.body.timezone,80)||null,referral=text(req.body.referralSource,120)||null,registration=text(req.body.registrationSource,40)||null;
            const discordId=text(req.body.discordUserId,32)||null;if(discordId&&!/^\d{5,32}$/.test(discordId))throw new Error('discord');
            const discordUsername=text(req.body.discordUsername,100)||null,note=text(req.body.note,2000),nextTags=tags(req.body.tags);
            await query(`UPDATE customers SET display_name=$2,phone=$3,country_code=$4,timezone=$5,referral_source=$6,registration_source=$7,discord_user_id=$8,discord_username=$9,marketing_opt_in=$10,tags=$11,note=$12,updated_at=NOW() WHERE id=$1`,[req.params.customerId,displayName,phone,country||null,timezone,referral,registration,discordId,discordUsername,bool(req.body.marketingOptIn),nextTags,note]);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.profile.update','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({fields:['display_name','phone','country_code','timezone','referral_source','registration_source','discord','marketing_opt_in','tags','note']})]);
            return res.redirect(path(req.params.customerId)+'&message='+encodeURIComponent('Customer profile updated.'));
        }catch(error){const message=error.message==='discord'?'Discord user ID must contain digits only.':error.code==='23505'?'That Discord user ID is already linked to another customer.':'Customer profile could not be updated safely.';return res.redirect(`/admin/users/${encodeURIComponent(req.params.customerId)}/edit-profile?error=${encodeURIComponent(message)}`)}
    });

    router.post('/admin/users/:customerId/policy-overrides',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            const changed=[];
            for(const field of policy.TECHNICAL_FIELDS){
                const raw=req.body[field];
                if(raw===undefined)continue;
                const value=String(raw).trim();
                if(value===''){
                    await provisioning.resetPolicyOverrideField(req.params.customerId,field,req.session.authUserId);
                }else if(field==='streams'){
                    const parsed=Number.parseInt(value,10);
                    if(!Number.isInteger(parsed)||parsed<1||parsed>50)throw new Error('validation');
                    await provisioning.setPolicyOverrideField(req.params.customerId,field,parsed,req.session.authUserId);
                }else{
                    if(value!=='true'&&value!=='false')throw new Error('validation');
                    await provisioning.setPolicyOverrideField(req.params.customerId,field,value==='true',req.session.authUserId);
                }
                changed.push(field);
            }
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.policy_override','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({fields:changed})]);
            let note='';
            try{await provisioning.reconcileCustomer(req.params.customerId)}catch(_){note=' Jellyfin is still catching up -- check reconciliation status below.'}
            return res.redirect(path(req.params.customerId,'access')+'&message='+encodeURIComponent('Policy overrides saved.'+note));
        }catch(error){
            return res.redirect(path(req.params.customerId,'access')+'&error='+encodeURIComponent('Policy overrides could not be saved safely.'));
        }
    });

    router.post('/admin/users/:customerId/policy-overrides/reset-all',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            await provisioning.resetAllPolicyOverrides(req.params.customerId,req.session.authUserId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.policy_override_reset_all','customer',$2,'{}'::jsonb)`,[req.session.authUserId,req.params.customerId]);
            try{await provisioning.reconcileCustomer(req.params.customerId)}catch(_){}
            return res.redirect(path(req.params.customerId,'access')+'&message='+encodeURIComponent('All policy overrides reset to plan.'));
        }catch(error){
            return res.redirect(path(req.params.customerId,'access')+'&error='+encodeURIComponent('Overrides could not be reset safely.'));
        }
    });

    router.post('/admin/users/:customerId/library-overrides',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            const plan=await provisioning.currentEntitlement(req.params.customerId);
            if(!plan)throw new Error('no_plan');
            const catalog=await provisioning.libraryCatalogForServerClass(plan.server_class);
            const known=new Set(catalog.names.map(n=>policy.nameKey(n)));
            const names=Array.isArray(req.body.libraryName)?req.body.libraryName:(req.body.libraryName!==undefined?[req.body.libraryName]:[]);
            const values=Array.isArray(req.body.libraryValue)?req.body.libraryValue:(req.body.libraryValue!==undefined?[req.body.libraryValue]:[]);
            const changed=[];
            for(let i=0;i<names.length;i++){
                const name=String(names[i]||'').trim();
                const value=String(values[i]||'').trim();
                if(!name||!known.has(policy.nameKey(name)))continue;
                if(value===''){
                    await provisioning.resetLibraryOverride(req.params.customerId,name);
                }else if(value==='true'||value==='false'){
                    await provisioning.setLibraryOverride(req.params.customerId,name,value==='true',req.session.authUserId);
                }else{
                    continue;
                }
                changed.push(name);
            }
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.library_override','customer',$2,$3::jsonb)`,[req.session.authUserId,req.params.customerId,JSON.stringify({libraries:changed})]);
            let note='';
            try{await provisioning.reconcileCustomer(req.params.customerId)}catch(_){note=' Jellyfin is still catching up -- check reconciliation status below.'}
            return res.redirect(path(req.params.customerId,'access')+'&message='+encodeURIComponent('Library overrides saved.'+note));
        }catch(error){
            return res.redirect(path(req.params.customerId,'access')+'&error='+encodeURIComponent(error.message==='no_plan'?'This customer has no active plan to override libraries against.':'Library overrides could not be saved safely.'));
        }
    });

    router.post('/admin/users/:customerId/library-overrides/reset-all',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            await provisioning.resetAllLibraryOverrides(req.params.customerId);
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.library_override_reset_all','customer',$2,'{}'::jsonb)`,[req.session.authUserId,req.params.customerId]);
            try{await provisioning.reconcileCustomer(req.params.customerId)}catch(_){}
            return res.redirect(path(req.params.customerId,'access')+'&message='+encodeURIComponent('All library overrides reset to plan.'));
        }catch(error){
            return res.redirect(path(req.params.customerId,'access')+'&error='+encodeURIComponent('Overrides could not be reset safely.'));
        }
    });

    router.use('/admin/users/:customerId',async(error,_req,res,_next)=>{console.error('Customer 360 route error:',error.message);await runtimeSettings.ensureLoaded().catch(()=>{});return res.status(500).render('auth/message',{siteName:runtimeSettings.siteName(),title:'Customer unavailable',message:'The customer profile could not be loaded safely.',link:'/admin/users',linkText:'Back to Customers'})});
    return router;
}
module.exports={createAdminCustomer360Router,TABS,incidentPanel};
