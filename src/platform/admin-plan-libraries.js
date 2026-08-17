'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const provisioning=require('../jellyfin/provisioning');
const planServers=require('../jellyfin/plan-servers');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function selectedValues(value){const values=Array.isArray(value)?value:[value];return Array.from(new Set(values.map(v=>String(v||'').trim()).filter(Boolean))).slice(0,500)}

async function planById(id){const r=await query('SELECT * FROM plans WHERE id=$1',[id]);return r.rows[0]||null}
async function liveEntitlements(planId){const r=await query(`SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW()`,[planId]);return Number(r.rows[0]?.n||0)}

async function discoverLibraries(planOrClass){
    const plan=typeof planOrClass==='string'?{server_class:planOrClass}:planOrClass;
    const servers=plan?.id||plan?.plan_id
        ?await planServers.eligibleServersForPlan(plan,{enabledOnly:true})
        :(await query(`SELECT id,name,health_status FROM jellyfin_servers WHERE enabled=TRUE AND server_class=$1 ORDER BY priority,name`,[plan?.server_class])).rows;
    const catalog=new Map();
    const failed=[];
    for(const server of servers){
        try{
            const folders=await provisioning.discoverServerLibraries(server.id);
            for(const folder of folders){
                const name=String(folder?.name||'').trim();
                if(!name||!folder?.id)continue;
                const key=name.toLocaleLowerCase('en-GB');
                if(!catalog.has(key))catalog.set(key,{name,servers:[]});
                catalog.get(key).servers.push(server.name);
            }
        }catch(error){
            console.warn(`Plan library discovery failed for server ${server.id}:`,error.message);
            failed.push(server.name);
        }
    }
    return{servers,catalog:Array.from(catalog.values()).sort((a,b)=>a.name.localeCompare(b.name)),failed};
}

async function page(req,plan,discovery){
    await runtimeSettings.ensureLoaded().catch(()=>{});
    const live=await liveEntitlements(plan.id),mode=['all','exclude','include'].includes(plan.library_access_mode)?plan.library_access_mode:'all';
    const chosen=new Set((Array.isArray(plan.library_names)?plan.library_names:[]).map(v=>String(v).toLocaleLowerCase('en-GB')));
    const total=Math.max(discovery.servers.length,1);
    const rows=discovery.catalog.map(item=>`<label class="libraryChoice"><input type="checkbox" name="libraryNames" value="${esc(item.name)}" ${chosen.has(item.name.toLocaleLowerCase('en-GB'))?'checked':''}><span><strong>${esc(item.name)}</strong><small>${item.servers.length}/${total} eligible server${total===1?'':'s'}</small></span></label>`).join('');
    const current=mode==='all'?'All libraries':mode==='exclude'?`All except ${(plan.library_names||[]).join(', ')||'none'}`:`Only ${(plan.library_names||[]).join(', ')||'no libraries'}`;
    const failed=discovery.failed.length?`<div class="notice error">Could not read libraries from: ${esc(discovery.failed.join(', '))}. No changes will be inferred from those servers.</div>`:'';
    const impact=live?`<div class="notice warn"><strong>Impact preview:</strong> ${live} live customer entitlement${live===1?'':'s'} use this plan. Saving queues policy reconciliation for those customers. Type <strong>${esc(plan.code)}</strong> to confirm.</div><div class="formGroup"><label>Impact confirmation</label><input class="input" name="impactConfirmation" autocomplete="off" required placeholder="${esc(plan.code)}"></div>`:'';
    const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<section class="section"><div class="sectionHead"><div><h2>Library access</h2><div class="settings-hint">Current: ${esc(current)}</div></div><span class="muted">${live} live entitlement${live===1?'':'s'}</span></div>${failed}<form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/libraries"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGroup"><label>Access mode</label><select class="input" name="libraryAccessMode"><option value="all" ${mode==='all'?'selected':''}>All libraries</option><option value="exclude" ${mode==='exclude'?'selected':''}>All libraries except selected</option><option value="include" ${mode==='include'?'selected':''}>Only selected libraries</option></select><div class="inlineHelp">Libraries are discovered only from this plan's eligible server pool, then resolved to the correct Jellyfin folder IDs on whichever server receives the customer.</div></div><div class="libraryGrid">${rows||'<div class="empty">No libraries could be discovered from the currently eligible servers. Configure placement or add a healthy eligible server first.</div>'}</div>${impact}<div class="buttonRow"><button class="button">Save library access</button></div></form></section>`;
    return layout({siteName:runtimeSettings.siteName(),active:'plans',title:`${plan.name} · Libraries`,subtitle:`${plan.server_class} server class`,body});
}

function createAdminPlanLibrariesRouter(){
    const router=express.Router();
    router.use('/admin/plans',gate,noStore);
    router.get('/admin/plans/:id/libraries',async(req,res,next)=>{try{const plan=await planById(req.params.id);if(!plan)return res.status(404).send('Plan not found');const discovery=await discoverLibraries(plan);return res.send(await page(req,plan,discovery))}catch(error){return next(error)}});
    router.post('/admin/plans/:id/libraries',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{
            const plan=await planById(req.params.id);if(!plan)throw new Error('missing');
            const live=await liveEntitlements(plan.id);
            if(live&&String(req.body.impactConfirmation||'').trim()!==String(plan.code))throw new Error('impact');
            const mode=['all','exclude','include'].includes(req.body.libraryAccessMode)?req.body.libraryAccessMode:'all';
            const discovery=await discoverLibraries(plan);
            if(discovery.failed.length)throw new Error('discovery');
            const available=new Map(discovery.catalog.map(x=>[x.name.toLocaleLowerCase('en-GB'),x.name]));
            const requested=selectedValues(req.body.libraryNames);
            const names=requested.map(name=>available.get(name.toLocaleLowerCase('en-GB'))).filter(Boolean);
            if(mode==='include'&&!names.length)throw new Error('empty_include');
            await transaction(async client=>{
                await client.query(`UPDATE plans SET library_access_mode=$2,library_names=$3::text[],updated_at=NOW() WHERE id=$1`,[plan.id,mode,mode==='all'?[]:names]);
                await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.library_access','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({mode,names,serverClass:plan.server_class,liveEntitlements:live})]);
            });
            const {queuePlanReconciliation}=require('./bulk-jobs');
            const job=await queuePlanReconciliation(plan.id,req.session.authUserId);
            return res.redirect(job?`/admin/jobs/${encodeURIComponent(job.id)}?message=${encodeURIComponent('Library access saved. Reconciliation queued for affected customers.')}`:`/admin/plans/${encodeURIComponent(plan.id)}/libraries?message=${encodeURIComponent('Library access saved.')}`);
        }catch(error){
            const msg=error.message==='impact'?'Type the plan code exactly to confirm the impact on live customers.':error.message==='empty_include'?'Choose at least one library for selected-only access.':error.message==='discovery'?'Library access was not changed because one or more eligible Jellyfin servers could not be read.':error.message==='missing'?'Plan not found.':'Library access could not be updated safely.';
            return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/libraries?error=${encodeURIComponent(msg)}`);
        }
    });
    return router;
}

module.exports={createAdminPlanLibrariesRouter,discoverLibraries,liveEntitlements};
