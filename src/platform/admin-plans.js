'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const {sendCsv}=require('./export');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function b(v){return v==='on'||v==='true'||v===true}
function n(v,min,max,f){const x=parseInt(v,10);return Number.isFinite(x)&&x>=min&&x<=max?x:f}
function t(v,max){return String(v||'').trim().slice(0,max)}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function csrfInput(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function confirmField(plan,count,label='live customer entitlements'){return Number(count)>0?`<div class="notice warn"><strong>Impact preview:</strong> this plan currently affects ${esc(count)} ${esc(label)}. Type <strong>${esc(plan.code)}</strong> below to confirm this change.</div><div class="formGroup"><label>Impact confirmation</label><input class="input" name="impactConfirmation" autocomplete="off" required placeholder="${esc(plan.code)}"></div>`:''}
function requireImpact(plan,count,value){if(Number(count)>0&&String(value||'').trim()!==String(plan.code))throw new Error(`Type ${plan.code} exactly to confirm the impact on ${count} live customer entitlements.`)}

function planSubnav(planId,active){const items=[['overview','Overview',`/admin/plans/${planId}/edit`],['jellyfin','Jellyfin',`/admin/plans/${planId}/jellyfin`],['libraries','Libraries',`/admin/plans/${planId}/libraries`],['placement','Placement',`/admin/plans/${planId}/placement`],['commerce','Commerce',`/admin/plans/${planId}/commerce`]];return `<div class="buttonRow planSubnav">${items.map(([key,label,url])=>`<a class="button ${active===key?'':'secondary'}" href="${url}">${label}</a>`).join('')}</div>`}
async function planById(id){const r=await query('SELECT * FROM plans WHERE id=$1',[id]);return r.rows[0]||null}
async function activeSubscriberCount(planId){const r=await query(`SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW()`,[planId]);return Number(r.rows[0]?.n||0)}
async function planImpact(planId){const [live,historical,providerMappings]=await Promise.all([activeSubscriberCount(planId),query('SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE plan_id=$1',[planId]),query('SELECT COUNT(*)::int n FROM plan_provider_prices WHERE plan_id=$1 AND active=TRUE',[planId])]);return{live,historical:Number(historical.rows[0]?.n||0),providerMappings:Number(providerMappings.rows[0]?.n||0)}}
async function listData(){const r=await query(`SELECT p.*,COALESCE(jsonb_agg(jsonb_build_object('provider',pp.provider,'externalId',pp.external_id,'checkoutMode',pp.checkout_mode,'active',pp.active)) FILTER(WHERE pp.id IS NOT NULL),'[]'::jsonb) provider_prices,(SELECT COUNT(*)::int FROM subscriptions s WHERE s.plan_id=p.id) subscription_count FROM plans p LEFT JOIN plan_provider_prices pp ON pp.plan_id=p.id GROUP BY p.id ORDER BY (p.archived_at IS NOT NULL),p.active DESC,p.sort_order,p.price_minor,p.name`);return r.rows}

function overviewInput(body,plan){
  const name=t(body.name,80),description=t(body.description,500),billing=['trial','month','6_months','year','custom'].includes(body.billingInterval)?body.billingInterval:'custom';
  if(!name)throw new Error('Enter a plan name.');
  if(plan.is_free_tier&&billing==='trial')throw new Error('The Free Access plan cannot be converted into a trial.');
  const features=[body.feature1,body.feature2,body.feature3,body.feature4].map(v=>t(v,90)).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,4);return{name,description,audience:plan.audience,billing,duration:n(body.durationDays,1,3650,30),serverClass:['premium','free','custom'].includes(body.serverClass)?body.serverClass:'premium',visible:plan.is_free_tier?true:b(body.visible),active:plan.is_free_tier?true:b(body.active),sort:plan.is_free_tier?0:n(body.sortOrder,0,10000,100),features};
}
function jellyfinInput(body){return{streams:n(body.streams,1,50,1),downloads:b(body.allowDownloads),video:b(body.allowVideoTranscoding),audio:b(body.allowAudioTranscoding),remux:b(body.allowRemuxing),live:b(body.allowLiveTv),liveManagement:b(body.allowLiveTvManagement),remoteAccess:b(body.allowRemoteAccess),fourk:b(body.allow4k)}}

async function overviewPage(req,plan){
  const impact=await planImpact(plan.id),free=Boolean(plan.is_free_tier),archiveState=plan.archived_at?`<div class="notice warn"><strong>Archived.</strong> This catalogue product is retired from new sales. Existing subscription contracts remain valid until their own paid-through dates.</div>`:'';
  const audienceNote=plan.audience==='direct'
    ? `<div class="securityNote standalone"><strong>Direct customer plan</strong><div class="subText">This is a direct customer plan. Configure what customers see and receive here.</div></div>`
    : `<div class="notice warn"><strong>Legacy audience:</strong> this historical plan is marked “${esc(plan.audience)}”. The reseller portal no longer consumes retail customer plans. Saving this page preserves that historical audience; create a new direct customer plan or a Reseller Plan for new business.</div>`;
  const catalogueControls=free
    ? `<div class="securityNote standalone"><strong>Free Access</strong><div class="subText">This plan is pinned on the homepage and must remain active and visible. Use Availability to set 0 when no free places should be claimable.</div></div>`
    : `<div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="visible" ${plan.visible?'checked':''}><span>Visible in applicable storefronts</span></label><label class="toggleRow"><input type="checkbox" name="active" ${plan.active?'checked':''}><span>Available for new acquisition / renewal workflows</span></label></div><div class="inlineHelp">These catalogue switches never revoke an already-created paid-through entitlement. Use customer billing/access controls for existing contracts.</div>`;
  const sortControl=free
    ? `<div class="formGroup"><label>Storefront order</label><div class="securityNote standalone"><strong>Pinned above plan cards</strong><div class="subText">Free Access is not part of the draggable paid-plan order.</div></div></div>`
    : `<div class="formGroup"><label>Storefront order</label><input class="input" type="number" name="sortOrder" value="${esc(plan.sort_order)}"><div class="inlineHelp">You can also drag plans into order from Plans → Storefront order.</div></div>`;
  const archiveAction=free?'':plan.archived_at?`<form method="post" action="/admin/plans/${esc(plan.id)}/unarchive">${csrfInput(req)}<button class="button secondary" type="submit">Restore to catalogue</button></form>`:`<a class="button secondary" href="/admin/plans/${esc(plan.id)}/archive-confirm">Archive plan</a>`;
  const body=`${notice(req)}${archiveState}${planSubnav(plan.id,'overview')}<section class="section"><div class="sectionHead"><div><h2>Product & commercial schedule</h2><div class="muted">${impact.live} live · ${impact.historical} historical customer entitlements</div></div>${free?'<span class="pill good">Free tier</span>':''}</div><form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}">${csrfInput(req)}${audienceNote}<div class="formGroup"><label>Name</label><input class="input" name="name" maxlength="80" value="${esc(plan.name)}" required></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(plan.description||'')}</textarea></div><div class="formGroup"><label>Homepage features <span class="muted">(up to 4)</span></label><div class="inlineHelp">Use simple customer-facing benefits, e.g. “3 concurrent streams”, “Downloads included”, “Unlimited requests”. Leave all four empty to use automatic plan features.</div><div class="formGrid">${[0,1,2,3].map(i=>`<input class="input" name="feature${i+1}" maxlength="90" value="${esc((plan.marketing_features||[])[i]||'')}" placeholder="Feature ${i+1}">`).join('')}</div></div><div class="formGrid"><div class="formGroup"><label>Billing interval</label><select class="input" name="billingInterval">${['trial','month','6_months','year','custom'].filter(x=>!free||x!=='trial').map(x=>`<option value="${x}" ${plan.billing_interval===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="formGroup"><label>Duration (days)</label><input class="input" type="number" name="durationDays" min="1" max="3650" value="${esc(plan.duration_days||30)}"></div><div class="formGroup"><label>Server class</label><select class="input" name="serverClass">${['premium','free','custom'].map(x=>`<option value="${x}" ${plan.server_class===x?'selected':''}>${x}</option>`).join('')}</select><div class="inlineHelp">Changing class clears explicit placement eligibility for future provisioning. Existing customers are not silently migrated.</div></div>${sortControl}</div>${catalogueControls}${confirmField(plan,impact.live)}<div class="buttonRow"><button class="button">Save overview</button><a class="button secondary" href="/admin/plans/${esc(plan.id)}/inventory">Availability</a></div></form>${archiveAction?`<div class="buttonRow">${archiveAction}</div>`:''}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:plan.name,subtitle:free?'Free Access · product and policy':'Customer plan overview and impact',body});
}

async function jellyfinPage(req,plan){
  const impact=await planImpact(plan.id),toggle=(name,label,checked)=>`<label class="toggleRow"><input type="checkbox" name="${name}" ${checked?'checked':''}><span>${esc(label)}</span></label>`;
  const body=`${notice(req)}${planSubnav(plan.id,'jellyfin')}<section class="section"><div class="sectionHead"><div><h2>Jellyfin policy</h2><div class="muted">Controls the actual Jellyfin permissions applied to customers on this plan.</div></div><span class="muted">${impact.live} live entitlements</span></div><form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/jellyfin">${csrfInput(req)}<div class="formGroup narrow"><label>Concurrent streams</label><input class="input" type="number" name="streams" min="1" max="50" value="${esc(plan.streams)}"></div><div class="toggleGrid">${toggle('allowDownloads','Downloads',plan.allow_downloads)}${toggle('allowVideoTranscoding','Video transcoding',plan.allow_video_transcoding)}${toggle('allowAudioTranscoding','Audio transcoding',plan.allow_audio_transcoding)}${toggle('allowRemuxing','Remuxing',plan.allow_remuxing)}${toggle('allowLiveTv','Live TV',plan.allow_live_tv)}${toggle('allowLiveTvManagement','Live TV recording / management',plan.allow_live_tv_management)}${toggle('allowRemoteAccess','Remote access',plan.allow_remote_access)}${toggle('allow4k','4K content',plan.allow_4k)}</div>${confirmField(plan,impact.live)}<button class="button">Save policy & reconcile affected customers</button></form></section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:plan.name,subtitle:'Jellyfin policy',body});
}

async function archiveConfirmPage(req,plan){
  if(plan.is_free_tier)throw new Error('The Free Access plan cannot be archived. Set Availability to 0 when no free spots should be claimable.');
  const impact=await planImpact(plan.id);
  const body=`${notice(req)}${planSubnav(plan.id,'overview')}<section class="section"><div class="sectionHead"><h2>Archive ${esc(plan.name)}</h2></div><div class="notice error"><strong>Impact preview:</strong> ${impact.live} live entitlements, ${impact.historical} historical customers and ${impact.providerMappings} active payment mappings reference this plan. Existing paid-through access/history is contract-backed and is preserved; the plan is retired from new catalogue acquisition.</div><form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/archive">${csrfInput(req)}<div class="formGroup"><label>Type ${esc(plan.code)} to archive</label><input class="input" name="impactConfirmation" required autocomplete="off"></div><button class="button btn-danger">Archive plan</button> <a class="button secondary" href="/admin/plans/${esc(plan.id)}/edit">Cancel</a></form></section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:'Archive plan',subtitle:plan.name,body});
}

async function assertNotAutomaticFreeTarget(plan){
  if(plan.is_free_tier)throw new Error('The Free Access plan cannot be disabled or archived. Set Availability to 0 instead.');
  const r=await query(`SELECT setting_value FROM platform_settings WHERE setting_key='trial_free_policy'`),v=r.rows[0]?.setting_value||{};
  if(v.downgradeToFree===true&&String(v.downgradeFreePlanCode||'')===String(plan.code))throw new Error('This plan is the configured automatic free-downgrade target. Choose another target in Commerce before archiving it.');
}

function createAdminPlansRouter(){
  const r=express.Router();r.use('/admin/plans',gate,noStore);
  r.get('/admin/plans/export',async(req,res,next)=>{try{const rows=await listData();return sendCsv(res,'plans.csv',[{key:'code',label:'Code'},{key:'name',label:'Name'},{key:'service_type',label:'Service type'},{key:'billing_interval',label:'Billing'},{key:'duration_days',label:'Duration days'},{label:'Price',value:p=>(Number(p.price_minor)/100).toFixed(2)},{key:'currency',label:'Currency'},{key:'streams',label:'Streams'},{key:'capacity_limit',label:'Capacity'},{key:'active',label:'Active'},{key:'visible',label:'Visible'},{key:'is_free_tier',label:'Permanent free tier'},{key:'archived_at',label:'Archived at'},{key:'subscription_count',label:'Subscriptions'}],rows)}catch(error){next(error)}});
  r.get('/admin/plans/:id/edit',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const plan=await planById(req.params.id);if(!plan)return res.status(404).send('Plan not found');return res.send(await overviewPage(req,plan))}catch(error){next(error)}});
  r.get('/admin/plans/:id/jellyfin',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const plan=await planById(req.params.id);if(!plan)return res.status(404).send('Plan not found');return res.send(await jellyfinPage(req,plan))}catch(error){next(error)}});
  r.get('/admin/plans/:id/archive-confirm',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const plan=await planById(req.params.id);if(!plan)return res.status(404).send('Plan not found');return res.send(await archiveConfirmPage(req,plan))}catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message)}`)}});

  r.post('/admin/plans/:id',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found.');
      const impact=await planImpact(plan.id);requireImpact(plan,impact.live,req.body.impactConfirmation);
      const p=overviewInput(req.body,plan);if(!p.active&&plan.active)await assertNotAutomaticFreeTarget(plan);
      await transaction(async client=>{
        const before=await client.query('SELECT server_class FROM plans WHERE id=$1 FOR UPDATE',[plan.id]),classChanged=before.rows[0].server_class!==p.serverClass;
        await client.query(`UPDATE plans SET name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,server_class=$7,visible=$8,active=$9,sort_order=$10,marketing_features=$11::text[],updated_at=NOW() WHERE id=$1`,[plan.id,p.name,p.description,p.audience,p.billing,p.duration,p.serverClass,p.visible,p.active,p.sort,p.features]);
        if(classChanged)await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1',[plan.id]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.update','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({...p,permanentFreeTier:Boolean(plan.is_free_tier),impact,classChanged})]);
      });
      return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?message=${encodeURIComponent(plan.is_free_tier?'Free Access overview saved. The plan remains permanently active and visible.':'Overview saved. Existing subscription contracts are unaffected by catalogue availability.')}`);
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message)}`)}
  });

  r.post('/admin/plans/:id/jellyfin',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found.');
      const impact=await planImpact(plan.id);requireImpact(plan,impact.live,req.body.impactConfirmation);const p=jellyfinInput(req.body);
      await query(`UPDATE plans SET streams=$2,allow_downloads=$3,allow_video_transcoding=$4,allow_audio_transcoding=$5,allow_remuxing=$6,allow_live_tv=$7,allow_live_tv_management=$8,allow_remote_access=$9,allow_4k=$10,updated_at=NOW() WHERE id=$1`,[plan.id,p.streams,p.downloads,p.video,p.audio,p.remux,p.live,p.liveManagement,p.remoteAccess,p.fourk]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.jellyfin_policy','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({...p,impact})]);
      const{queuePlanReconciliation}=require('./bulk-jobs'),job=await queuePlanReconciliation(plan.id,req.session.authUserId);
      return res.redirect(job?`/admin/jobs/${encodeURIComponent(job.id)}?message=${encodeURIComponent('Policy saved; affected customers were queued for reconciliation.')}`:`/admin/plans/${encodeURIComponent(plan.id)}/jellyfin?message=${encodeURIComponent('Policy saved.')}`);
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/jellyfin?error=${encodeURIComponent(error.message)}`)}
  });

  // Legacy single-price commerce posts are no longer part of the visible UI.
  // Preserve a safe redirect for old bookmarks/forms without retaining reseller-credit semantics.
  r.post('/admin/plans/:id/commerce',(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/commerce?message=${encodeURIComponent('Use the multi-currency Commerce controls on this page.')}`)});

  r.post('/admin/plans/:id/archive',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found.');
      if(plan.is_free_tier)throw new Error('The Free Access plan cannot be archived. Set Availability to 0 instead.');
      if(String(req.body.impactConfirmation||'').trim()!==String(plan.code))throw new Error(`Type ${plan.code} exactly to archive this plan.`);
      await assertNotAutomaticFreeTarget(plan);
      await query(`UPDATE plans SET active=FALSE,visible=FALSE,archived_at=NOW(),archived_by=$2,updated_at=NOW() WHERE id=$1`,[plan.id,req.session.authUserId]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.archive','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify(await planImpact(plan.id))]);
      return res.redirect('/admin/plans?message='+encodeURIComponent('Plan archived from new sales. Existing paid-through contracts remain active.'));
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message)}`)}
  });

  r.post('/admin/plans/:id/unarchive',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const plan=await planById(req.params.id);if(!plan)throw new Error('Plan not found.');
      if(plan.is_free_tier)throw new Error('Free Access is permanently part of the catalogue and does not need restoring.');
      await query(`UPDATE plans SET archived_at=NULL,archived_by=NULL,active=TRUE,visible=FALSE,updated_at=NOW() WHERE id=$1`,[plan.id]);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.unarchive','plan',$2,'{}'::jsonb)`,[req.session.authUserId,plan.id]);
      return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?message=${encodeURIComponent('Plan restored to the catalogue as active but hidden. Review it, then enable storefront visibility when ready.')}`);
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message)}`)}
  });

  r.use('/admin/plans',async(error,_req,res,_next)=>{console.error('Plans error:',error.message);await runtimeSettings.ensureLoaded().catch(()=>{});return res.status(500).render('auth/message',{siteName:runtimeSettings.siteName(),title:'Plans unavailable',message:'Plans could not be loaded safely.',link:'/admin',linkText:'Back'})});
  return r;
}

module.exports={createAdminPlansRouter,listData,planSubnav,planById,activeSubscriberCount,planImpact,overviewPage,jellyfinPage,overviewInput,jellyfinInput};
