'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const monthly = require('../resellers/monthly');
const { esc, layout } = require('./admin-html');

function site() { return process.env.SITE_NAME || 'CAPTaINFiN'; }
function gate(req,res,next){ if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId) return next(); return res.redirect('/login?session=expired'); }
function noStore(_req,res,next){ res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function text(v,max=500){ return String(v||'').trim().slice(0,max); }
function bool(v){ return v==='on'||v==='true'||v===true; }
function integer(v,min,max){ const n=Number.parseInt(v,10); if(!Number.isInteger(n)||n<min||n>max) throw new Error('Enter a valid whole number.'); return n; }
function priceMinor(v){ const n=Number(v); if(!Number.isFinite(n)||n<0||n>1000000) throw new Error('Enter a valid monthly price.'); return Math.round(n*100); }
function currency(v){ const c=text(v,3).toUpperCase(); if(!/^[A-Z]{3}$/.test(c)) throw new Error('Currency must be a three-letter code such as GBP.'); return c; }
function token(req){ return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(req){ return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`; }
function redirect(res,path,key,msg){ return res.redirect(`${path}?${key}=${encodeURIComponent(msg)}`); }

function tierForm(req,tier={}){
    const editing=Boolean(tier.id);
    const providers=Array.isArray(tier.provider_prices)?tier.provider_prices:[];
    const stripe=providers.find(p=>p.provider==='stripe');
    const paypal=providers.find(p=>p.provider==='paypal');
    const action=editing?`/admin/reseller-tiers/${encodeURIComponent(tier.id)}`:'/admin/reseller-tiers';
    return `<form class="formPanel" method="post" action="${action}">${token(req)}
        <div class="formGrid">
            <div class="formGroup"><label>Code</label><input class="input" name="code" ${editing?'readonly':''} required pattern="[a-z0-9][a-z0-9-]{1,49}" value="${esc(tier.code||'') }" placeholder="reseller-starter"></div>
            <div class="formGroup"><label>Name</label><input class="input" name="name" required maxlength="80" value="${esc(tier.name||'') }" placeholder="Starter Reseller"></div>
        </div>
        <div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(tier.description||'')}</textarea></div>
        <div class="formGrid">
            <div class="formGroup"><label>Monthly price</label><input class="input" type="number" name="price" min="0" step="0.01" required value="${tier.monthly_price_minor!=null?(Number(tier.monthly_price_minor)/100).toFixed(2):''}"><div class="inlineHelp">This is what you charge the reseller every month.</div></div>
            <div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="3" required value="${esc(tier.currency||'GBP')}"></div>
            <div class="formGroup"><label>Active Jellyfin accounts included</label><input class="input" type="number" name="seatLimit" min="1" max="100000" required value="${esc(tier.seat_limit||5)}"><div class="inlineHelp">The reseller's own Jellyfin account counts as one seat when created.</div></div>
            <div class="formGroup"><label>Sort order</label><input class="input" type="number" name="sortOrder" min="0" max="10000" value="${esc(tier.sort_order??100)}"></div>
        </div>
        <div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="visible" ${tier.visible!==false?'checked':''}><span>Show on public storefront</span></label><label class="toggleRow"><input type="checkbox" name="active" ${tier.active!==false?'checked':''}><span>Available for new reseller subscriptions</span></label></div>
        <hr class="divider">
        <div class="sectionHead"><h3>Recurring payment mappings</h3><span class="muted">Monthly subscriptions only</span></div>
        <div class="formGrid">
            <div class="formGroup"><label>Stripe recurring Price ID</label><input class="input" name="stripePriceId" maxlength="200" value="${esc(stripe?.externalId||stripe?.external_id||'')}" placeholder="price_..."></div>
            <div class="formGroup"><label>PayPal Billing Plan ID</label><input class="input" name="paypalPlanId" maxlength="200" value="${esc(paypal?.externalId||paypal?.external_id||'')}" placeholder="P-..."></div>
        </div>
        <div class="securityNote standalone">Both mappings are optional. A reseller can only choose gateways configured here and enabled under Commerce → Payments.</div>
        <button class="button">${editing?'Save reseller tier':'Create reseller tier'}</button>
    </form>`;
}

async function tierRows(){
    const tiers=await monthly.listTiers();
    const counts=await query(`SELECT tier_id,COUNT(*) FILTER(WHERE status='active' AND current_period_end>NOW())::int active_count,COUNT(*)::int total_count FROM reseller_subscriptions GROUP BY tier_id`);
    const map=new Map(counts.rows.map(x=>[String(x.tier_id),x]));
    return tiers.map(t=>({...t,...(map.get(String(t.id))||{active_count:0,total_count:0})}));
}

function tierCard(t){
    const providers=Array.isArray(t.provider_prices)?t.provider_prices.filter(p=>p.active):[];
    return `<article class="serverCard"><div class="serverTop"><div><strong>${esc(t.name)}</strong><div class="subText">${esc(t.code)}</div></div><span class="pill ${t.active?'good':'bad'}">${t.active?'Active':'Archived'}</span></div>
        <div class="serverStats"><div><span class="metricMini">${esc(t.currency)} ${(Number(t.monthly_price_minor)/100).toFixed(2)}</span><span class="subText">per month</span></div><div><span class="metricMini">${esc(t.seat_limit)}</span><span class="subText">active accounts</span></div><div><span class="metricMini">${esc(t.active_count||0)}</span><span class="subText">active resellers</span></div></div>
        <p class="muted">${esc(t.description||'No description')}</p><p>${providers.map(p=>`<span class="pill">${esc(p.provider)}</span>`).join(' ')||'<span class="pill warn">No payment mapping</span>'}</p>
        <a class="button secondary btn-sm" href="/admin/reseller-tiers/${encodeURIComponent(t.id)}">Edit</a></article>`;
}

async function listPage(req){
    const [tiers,resellers]=await Promise.all([
        tierRows(),
        query(`SELECT r.id,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE u.active=TRUE ORDER BY u.username`)
    ]);
    const active=tiers.filter(t=>t.active).length;
    const monthly=tiers.reduce((sum,t)=>sum+Number(t.active_count||0)*Number(t.monthly_price_minor||0),0);
    const body=`${notice(req)}<div class="metrics"><div class="metric"><div class="metricLabel">Reseller tiers</div><div class="metricValue">${tiers.length}</div></div><div class="metric"><div class="metricLabel">Active tiers</div><div class="metricValue">${active}</div></div><div class="metric"><div class="metricLabel">Active reseller subscriptions</div><div class="metricValue">${tiers.reduce((s,t)=>s+Number(t.active_count||0),0)}</div></div><div class="metric"><div class="metricLabel">Configured MRR</div><div class="metricValue">${tiers.length?`${esc(tiers[0]?.currency||'GBP')} ${(monthly/100).toFixed(2)}`:'—'}</div></div></div>
        <section class="section"><div class="sectionHead"><h2>Monthly reseller tiers</h2><span class="muted">Recurring access · active-account limits</span></div>${tiers.length?`<div class="serverGrid">${tiers.map(tierCard).join('')}</div>`:'<div class="empty">No reseller tiers yet. Create Starter, Business and Pro tiers here.</div>'}</section>
        <section class="section"><div class="sectionHead"><h2>Create reseller tier</h2></div>${tierForm(req)}</section>
        <section class="section"><div class="sectionHead"><h2>Manual reseller entitlement</h2><span class="muted">For complimentary access, migration or testing</span></div>${tiers.filter(t=>t.active).length&&resellers.rowCount?`<form class="formPanel" method="post" action="/admin/reseller-tiers/manual-subscription">${token(req)}<div class="formGrid"><div class="formGroup"><label>Reseller</label><select class="input" name="resellerId">${resellers.rows.map(r=>`<option value="${esc(r.id)}">${esc(r.username)}</option>`).join('')}</select></div><div class="formGroup"><label>Tier</label><select class="input" name="tierId">${tiers.filter(t=>t.active).map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${esc(t.seat_limit)} accounts</option>`).join('')}</select></div><div class="formGroup"><label>Months</label><input class="input" type="number" name="months" min="1" max="36" value="1"></div></div><button class="button secondary">Grant / extend manually</button></form>`:'<div class="empty">Create a tier and reseller first.</div>'}</section>`;
    return layout({siteName:site(),active:'reseller-tiers',title:'Reseller Plans',subtitle:'Monthly recurring reseller revenue and active-account allowances',body});
}

async function saveTier(req,{id=null}={}){
    const code=text(req.body.code,50).toLowerCase();
    const name=text(req.body.name,80);
    if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)) throw new Error('Code must use lowercase letters, numbers and hyphens.');
    if(!name) throw new Error('Tier name is required.');
    const values={code,name,description:text(req.body.description,500),price:priceMinor(req.body.price),currency:currency(req.body.currency),seatLimit:integer(req.body.seatLimit,1,100000),sortOrder:integer(req.body.sortOrder||100,0,10000),visible:bool(req.body.visible),active:bool(req.body.active),stripe:text(req.body.stripePriceId,200),paypal:text(req.body.paypalPlanId,200)};
    return transaction(async client=>{
        let tierId=id;
        if(id){
            const updated=await client.query(`UPDATE reseller_tiers SET name=$2,description=$3,monthly_price_minor=$4,currency=$5,seat_limit=$6,sort_order=$7,visible=$8,active=$9,updated_at=NOW() WHERE id=$1 RETURNING id`,[id,values.name,values.description,values.price,values.currency,values.seatLimit,values.sortOrder,values.visible,values.active]);
            if(!updated.rowCount) throw new Error('Reseller tier not found.');
        } else {
            const created=await client.query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,sort_order,visible,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[values.code,values.name,values.description,values.price,values.currency,values.seatLimit,values.sortOrder,values.visible,values.active]);
            tierId=created.rows[0].id;
        }
        for(const [provider,external] of [['stripe',values.stripe],['paypal',values.paypal]]){
            if(external) await client.query(`INSERT INTO reseller_tier_provider_prices(tier_id,provider,external_id,active) VALUES($1,$2,$3,TRUE) ON CONFLICT(tier_id,provider) DO UPDATE SET external_id=EXCLUDED.external_id,active=TRUE,updated_at=NOW()`,[tierId,provider,external]);
            else await client.query('DELETE FROM reseller_tier_provider_prices WHERE tier_id=$1 AND provider=$2',[tierId,provider]);
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'reseller_tier',$3,$4::jsonb)`,[req.session.authUserId,id?'admin.reseller_tier.update':'admin.reseller_tier.create',tierId,JSON.stringify({code:values.code,name:values.name,monthlyPriceMinor:values.price,currency:values.currency,seatLimit:values.seatLimit})]);
        return tierId;
    });
}

function createAdminResellerTiersRouter(){
    const r=express.Router(); r.use('/admin/reseller-tiers',gate,noStore);
    r.get('/admin/reseller-tiers',async(req,res,next)=>{try{return res.send(await listPage(req));}catch(e){next(e);}});
    r.get('/admin/reseller-tiers/:id',async(req,res,next)=>{try{const tiers=await monthly.listTiers();const tier=tiers.find(t=>String(t.id)===String(req.params.id));if(!tier)return res.status(404).send('Tier not found');return res.send(layout({siteName:site(),active:'reseller-tiers',title:tier.name,subtitle:'Monthly reseller tier',body:`${notice(req)}<section class="section">${tierForm(req,tier)}</section>`,action:'<a class="button secondary" href="/admin/reseller-tiers">Back</a>'}));}catch(e){next(e);}});
    r.post('/admin/reseller-tiers',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{if(!(await auth.verifySecondFactor(req.session.authUserId,req.body.code,req)))throw new Error('Verification failed.');await saveTier(req);return redirect(res,'/admin/reseller-tiers','message','Reseller tier created.');}catch(e){return redirect(res,'/admin/reseller-tiers','error',e.code==='23505'?'That tier code or provider ID already exists.':e.message);}});
    r.post('/admin/reseller-tiers/manual-subscription',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await monthly.createManualTierSubscription({resellerId:req.body.resellerId,tierId:req.body.tierId,months:req.body.months,actorUserId:req.session.authUserId});return redirect(res,'/admin/reseller-tiers','message','Reseller subscription granted. Estate access reconciled.');}catch(e){return redirect(res,'/admin/reseller-tiers','error',e.message);}});
    r.post('/admin/reseller-tiers/:id',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await saveTier(req,{id:req.params.id});return redirect(res,`/admin/reseller-tiers/${encodeURIComponent(req.params.id)}`,'message','Reseller tier saved.');}catch(e){return redirect(res,`/admin/reseller-tiers/${encodeURIComponent(req.params.id)}`,'error',e.code==='23505'?'That provider ID is already mapped elsewhere.':e.message);}});
    return r;
}

module.exports={createAdminResellerTiersRouter,tierRows,saveTier};
