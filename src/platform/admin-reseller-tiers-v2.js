'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const monthly=require('../resellers/monthly');
const tierPricing=require('../payments/reseller-tier-pricing');
const mappingVerifier=require('../payments/provider-mapping-verification');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function text(v,max=500){return String(v||'').trim().slice(0,max)}
function bool(v){return['on','true','1','yes'].includes(String(v||'').toLowerCase())}
function integer(v,min,max,fallback=null){const raw=String(v??'').trim(),n=Number.parseInt(raw,10);if(Number.isInteger(n)&&String(n)===raw&&n>=min&&n<=max)return n;if(fallback!==null)return fallback;throw new Error(`Enter a whole number from ${min} to ${max}.`)}
function priceMinor(v,{nullable=false}={}){const raw=String(v??'').trim();if(!raw&&nullable)return null;if(!/^\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('Enter a valid monthly price.');const n=Number(raw);if(!Number.isFinite(n)||n<0||n>1000000)throw new Error('Enter a valid monthly price.');return Math.round(n*100)}
function names(v){return[...new Set(String(v||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean).map(x=>x.slice(0,200)))].slice(0,500)}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function redirect(res,path,key,message){return res.redirect(`${path}?${key}=${encodeURIComponent(message)}`)}
function money(minor,cur='GBP'){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(cur||'GBP').trim(),minimumFractionDigits:2}).format(Number(minor||0)/100)}catch{return `${cur} ${(Number(minor||0)/100).toFixed(2)}`}}
function checked(v){return v?'checked':''}
function selected(a,b){return String(a)===String(b)?'selected':''}
function toggle(name,label,value,help=''){return `<label class="toggleRow"><input type="checkbox" name="${esc(name)}" ${checked(Boolean(value))}><span><strong>${esc(label)}</strong>${help?`<small class="muted">${esc(help)}</small>`:''}</span></label>`}
function providerStatus(row){if(!row)return'';const status=row.verification_status||'unverified',kind=['verified','not_required'].includes(status)?'good':['drift','error'].includes(status)?'bad':'warn';return `<div class="subText"><span class="pill ${kind}">${esc(status)}</span>${row.verification_error?` ${esc(row.verification_error)}`:''}</div>`}

async function tierRows(){
  const tiers=await monthly.listTiers();
  const counts=await query(`SELECT tier_id,COUNT(*) FILTER(WHERE status='active' AND current_period_end>NOW())::int active_count,COUNT(*)::int total_count FROM reseller_subscriptions GROUP BY tier_id`);
  const map=new Map(counts.rows.map(row=>[String(row.tier_id),row]));
  return tiers.map(t=>({...t,...(map.get(String(t.id))||{active_count:0,total_count:0})}));
}

async function commercialMrr(){
  return (await query(`SELECT COALESCE(rs.currency_snapshot,rt.currency) currency,SUM(COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor))::bigint amount_minor,COUNT(*)::int subscriptions FROM reseller_subscriptions rs JOIN reseller_tiers rt ON rt.id=rs.tier_id WHERE rs.status='active' AND rs.current_period_end>NOW() GROUP BY 1 ORDER BY 1`)).rows;
}

function priceFor(tier,c){return (tier.prices||[]).find(p=>String(p.currency).trim()===c)||null}
function mappingFor(tier,c,provider){const price=priceFor(tier,c);return price?(tier.provider_prices||[]).find(p=>String(p.tier_price_id)===String(price.id)&&p.provider===provider)||null:null}
function pricingRow(tier,c){const price=priceFor(tier,c),stripe=mappingFor(tier,c,'stripe'),paypal=mappingFor(tier,c,'paypal');return `<div class="formGrid" style="align-items:end"><div class="formGroup"><label>${c} monthly price</label><input class="input" type="number" name="price${c}" min="0" step="0.01" value="${price?(Number(price.price_minor)/100).toFixed(2):''}" placeholder="Leave blank to disable ${c}"></div><div class="formGroup"><label>${c} Stripe recurring Price ID</label><input class="input" name="stripe${c}" maxlength="200" value="${esc(stripe?.external_id||'')}" placeholder="price_...">${providerStatus(stripe)}</div><div class="formGroup"><label>${c} PayPal Billing Plan ID</label><input class="input" name="paypal${c}" maxlength="200" value="${esc(paypal?.external_id||'')}" placeholder="P-...">${providerStatus(paypal)}</div></div>`}

function tierForm(req,tier={}){
  const editing=Boolean(tier.id),action=editing?`/admin/reseller-tiers/${encodeURIComponent(tier.id)}`:'/admin/reseller-tiers',libraryMode=['all','include','exclude'].includes(tier.library_access_mode)?tier.library_access_mode:'all',defaultCurrency=String(tier.currency||'GBP').trim();
  return `<form class="formPanel" method="post" action="${action}">${token(req)}
<h3>1. Product</h3><div class="formGrid"><div class="formGroup"><label>Code</label><input class="input" name="code" ${editing?'readonly':''} required pattern="[a-z0-9][a-z0-9-]{1,49}" value="${esc(tier.code||'')}"></div><div class="formGroup"><label>Name</label><input class="input" name="name" required maxlength="80" value="${esc(tier.name||'')}"></div></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500">${esc(tier.description||'')}</textarea></div>
<h3>2. Pricing</h3><div class="securityNote standalone"><strong>Monthly seat licence:</strong> configure the currencies you want to sell, exactly like customer/Stremio plan pricing. One currency is the default compatibility/reporting price; each currency can have its own Stripe and PayPal recurring mapping.</div><div class="formGroup narrow"><label>Default currency</label><select class="input" name="defaultCurrency">${tierPricing.CURRENCIES.map(c=>`<option value="${c}" ${selected(c,defaultCurrency)}>${c}</option>`).join('')}</select></div>${tierPricing.CURRENCIES.map(c=>pricingRow(tier,c)).join('')}
<h3>3. Capacity & lifecycle</h3><div class="formGrid"><div class="formGroup"><label>Managed Jellyfin users / reseller</label><input class="input" type="number" name="seatLimit" min="1" max="100000" required value="${esc(tier.seat_limit||5)}"><div class="inlineHelp">Each managed Jellyfin user occupies one seat until deleted. Suspending a user does not release the seat.</div></div><div class="formGroup"><label>Reseller subscriptions available</label><input class="input" type="number" name="capacityLimit" min="0" max="1000000" required value="${esc(tier.capacity_limit??0)}"><div class="inlineHelp">0 keeps the plan visible but closed while setup is incomplete.</div></div><div class="formGroup"><label>Payment grace days</label><input class="input" type="number" name="graceDays" min="0" max="30" value="${esc(tier.grace_days??0)}"></div><div class="formGroup"><label>Storefront order</label><input class="input" type="number" name="sortOrder" min="0" max="10000" value="${esc(tier.sort_order??100)}"></div></div>
<h3>4. Jellyfin user policy</h3><div class="formGrid"><div class="formGroup"><label>Concurrent streams per managed user</label><input class="input" type="number" name="streams" min="1" max="50" required value="${esc(tier.streams??1)}"></div><div class="formGroup"><label>Server class</label><select class="input" name="serverClass">${['premium','free','custom'].map(x=>`<option value="${x}" ${selected(x,tier.server_class||'premium')}>${x}</option>`).join('')}</select></div><div class="formGroup"><label>Placement strategy</label><select class="input" name="placementStrategy"><option value="least_users" ${selected('least_users',tier.placement_strategy||'least_users')}>Least users</option><option value="least_streams" ${selected('least_streams',tier.placement_strategy)}>Least active streams</option><option value="weighted" ${selected('weighted',tier.placement_strategy)}>Weighted</option></select></div></div><div class="toggleGrid">${toggle('allowDownloads','Downloads',tier.allow_downloads)}${toggle('allowVideoTranscoding','Video transcoding',tier.allow_video_transcoding)}${toggle('allowAudioTranscoding','Audio transcoding',tier.allow_audio_transcoding!==false)}${toggle('allowRemuxing','Remuxing',tier.allow_remuxing!==false)}${toggle('allowLiveTv','Live TV',tier.allow_live_tv)}${toggle('allowLiveTvManagement','Live TV recording / management',tier.allow_live_tv_management)}${toggle('allowRemoteAccess','Remote access',tier.allow_remote_access!==false)}${toggle('allow4k','4K catalogue flag',tier.allow_4k,'Use library access below to enforce 1080p-only or 4K-only visibility.')}</div>
<h3>5. Jellyfin libraries</h3><div class="formGrid"><div class="formGroup"><label>Library access</label><select class="input" name="libraryAccessMode"><option value="all" ${selected('all',libraryMode)}>All libraries</option><option value="include" ${selected('include',libraryMode)}>Only named libraries</option><option value="exclude" ${selected('exclude',libraryMode)}>All except named libraries</option></select></div><div class="formGroup"><label>Library names</label><textarea class="input" name="libraryNames" rows="4" placeholder="Movies 1080p\nTV 1080p">${esc((tier.library_names||[]).join('\n'))}</textarea><div class="inlineHelp">One per line or comma-separated.</div></div></div>
<h3>6. Storefront</h3><div class="toggleGrid">${toggle('visible','Visible on reseller storefront',tier.visible!==false)}${toggle('active','Available for new subscriptions',tier.active!==false)}</div><div class="securityNote standalone"><strong>Policy model:</strong> managed users inherit the current Jellyfin rules. Existing reseller subscriptions keep their snapshotted price and seat allowance.</div><button class="button">${editing?'Verify & save reseller plan':'Verify & create reseller plan'}</button></form>`;
}

function tierCard(t){const prices=(t.prices||[]).filter(p=>p.active),scheduled=t.effective_from&&new Date(t.effective_from)>new Date(),status=t.active?(scheduled?'Scheduled':Number(t.capacity_limit||0)===0?'Closed':'Active'):'Inactive';return `<article class="serverCard"><div class="serverTop"><div><strong>${esc(t.name)}</strong><div class="subText">${esc(t.code)} · Jellyfin seat licence</div></div><span class="pill ${t.active&&Number(t.capacity_limit||0)>0&&!scheduled?'good':'warn'}">${esc(status)}</span></div><div class="serverStats"><div><span class="metricMini">${prices.length?prices.map(p=>money(p.price_minor,p.currency)).join(' · '):money(t.monthly_price_minor,t.currency)}</span><span class="subText">monthly prices</span></div><div><span class="metricMini">${esc(t.seat_limit)}</span><span class="subText">managed users</span></div><div><span class="metricMini">${esc(t.streams||1)}</span><span class="subText">streams / user</span></div><div><span class="metricMini">${esc(t.active_count||0)}</span><span class="subText">active resellers</span></div></div><p class="subText">${esc(t.server_class||'premium')} servers · ${t.allow_video_transcoding?'video transcode allowed':'no video transcode'} · ${t.library_access_mode==='all'?'all libraries':`${esc(t.library_access_mode)} ${(t.library_names||[]).length} named libraries`}</p><div class="buttonRow"><a class="button secondary btn-sm" href="/admin/reseller-tiers/${encodeURIComponent(t.id)}">Manage plan</a><a class="button secondary btn-sm" href="/admin/catalog/tier/${encodeURIComponent(t.id)}/clone">Clone/version</a></div></article>`}

async function listPage(req){
  await runtimeSettings.ensureLoaded();
  const [tiers,resellers,mrr]=await Promise.all([tierRows(),query(`SELECT r.id,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id ORDER BY u.username`),commercialMrr()]);
  const mrrLabel=mrr.length?mrr.map(r=>money(r.amount_minor,r.currency)).join(' + '):'—';
  const body=`${notice(req)}<div class="metrics"><div class="metric"><div class="metricLabel">Reseller plans</div><div class="metricValue">${tiers.length}</div></div><div class="metric"><div class="metricLabel">Open plans</div><div class="metricValue">${tiers.filter(t=>t.active&&Number(t.capacity_limit||0)>0).length}</div></div><div class="metric"><div class="metricLabel">Live reseller subscriptions</div><div class="metricValue">${tiers.reduce((s,t)=>s+Number(t.active_count||0),0)}</div></div><div class="metric"><div class="metricLabel">Reseller MRR</div><div class="metricValue" style="font-size:18px">${esc(mrrLabel)}</div></div></div><section class="section"><div class="sectionHead"><div><h2>Monthly reseller plans</h2><div class="muted">One monthly subscription grants a fixed number of managed Jellyfin users. Downstream customer billing stays outside CAPTAiNFiN.</div></div></div>${tiers.length?`<div class="serverGrid">${tiers.map(tierCard).join('')}</div>`:'<div class="empty">No reseller plans yet.</div>'}</section><section class="section"><div class="sectionHead"><h2>Create reseller plan</h2></div>${tierForm(req)}</section><section class="section"><div class="sectionHead"><h2>Manual reseller subscription</h2></div>${tiers.filter(t=>t.active).length&&resellers.rowCount?`<form class="formPanel" method="post" action="/admin/reseller-tiers/manual-subscription">${token(req)}<div class="formGrid"><select class="input" name="resellerId">${resellers.rows.map(r=>`<option value="${esc(r.id)}">${esc(r.username)}</option>`).join('')}</select><select class="input" name="tierId">${tiers.filter(t=>t.active).map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select><input class="input" type="number" name="months" min="1" max="36" value="1"></div><button class="button secondary">Grant / extend manually</button></form>`:'<div class="empty">Create a reseller plan and reseller first.</div>'}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'reseller-tiers',title:'Reseller Plans',subtitle:'Monthly seat licensing with familiar product → pricing → policy → storefront setup',body});
}

async function detailPage(req){
  await runtimeSettings.ensureLoaded();
  const tiers=await tierRows(),tier=tiers.find(t=>String(t.id)===String(req.params.id));
  if(!tier)return null;
  const impact=await query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='active' AND current_period_end>NOW())::int active FROM reseller_subscriptions WHERE tier_id=$1`,[tier.id]);
  const i=impact.rows[0];
  const body=`${notice(req)}<div class="statusBanner"><strong>Impact preview:</strong> ${esc(i.active)} active / ${esc(i.total)} historical reseller subscriptions reference this plan. Commercial price and seat allowance stay snapshotted; Jellyfin policy changes apply to managed users.</div><section class="section">${tierForm(req,tier)}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'reseller-tiers',title:tier.name,subtitle:'Product, multicurrency pricing, managed-user policy and storefront',body,action:`<a class="button secondary" href="/admin/catalog/tier/${esc(tier.id)}/clone">Clone/version</a> <a class="button secondary" href="/admin/reseller-tiers">Back</a>`});
}

function parsePrices(body){
  const defaultCurrency=tierPricing.cleanCurrency(body.defaultCurrency,'GBP'),prices={};
  for(const c of tierPricing.CURRENCIES){
    const amount=priceMinor(body[`price${c}`],{nullable:true});
    if(amount!==null)prices[c]={currency:c,priceMinor:amount,isDefault:c===defaultCurrency,stripe:text(body[`stripe${c}`],200),paypal:text(body[`paypal${c}`],200)};
  }
  if(!Object.keys(prices).length)throw new Error('Configure at least one monthly reseller price.');
  if(!prices[defaultCurrency])throw new Error(`Configure a ${defaultCurrency} price before making it the default currency.`);
  return{defaultCurrency,prices};
}

async function verifiedMapping(provider,external,price){
  if(!external)return null;
  const result=await mappingVerifier.verify(provider,external,{priceMinor:price.priceMinor,currency:price.currency,checkoutMode:'subscription',billingInterval:'month'});
  if(result.issues.length)throw new Error(`${price.currency} ${provider} mapping does not match this reseller price: ${result.issues.join('; ')}`);
  return mappingVerifier.fields(result);
}

async function saveTier(req,{id=null}={}){
  const code=text(req.body.code,50).toLowerCase(),name=text(req.body.name,80);
  if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code))throw new Error('Code must use lowercase letters, numbers and hyphens.');
  if(!name)throw new Error('Plan name is required.');
  const pricing=parsePrices(req.body),libraryMode=['all','include','exclude'].includes(req.body.libraryAccessMode)?req.body.libraryAccessMode:'all',libraryNames=names(req.body.libraryNames);
  if(libraryMode!=='all'&&!libraryNames.length)throw new Error('Enter at least one library when using Include only or Exclude selected libraries.');
  const values={code,name,description:text(req.body.description,500),seatLimit:integer(req.body.seatLimit,1,100000),capacityLimit:integer(req.body.capacityLimit,0,1000000,0),graceDays:integer(req.body.graceDays,0,30,0),sortOrder:integer(req.body.sortOrder||100,0,10000),streams:integer(req.body.streams,1,50,1),serverClass:['premium','free','custom'].includes(req.body.serverClass)?req.body.serverClass:'premium',placementStrategy:['least_users','least_streams','weighted'].includes(req.body.placementStrategy)?req.body.placementStrategy:'least_users',downloads:bool(req.body.allowDownloads),video:bool(req.body.allowVideoTranscoding),audio:bool(req.body.allowAudioTranscoding),remux:bool(req.body.allowRemuxing),live:bool(req.body.allowLiveTv),liveManagement:bool(req.body.allowLiveTvManagement),remote:bool(req.body.allowRemoteAccess),fourk:bool(req.body.allow4k),libraryMode,libraryNames,visible:bool(req.body.visible),active:bool(req.body.active)};
  const verification={};
  for(const [c,p] of Object.entries(pricing.prices))verification[c]={stripe:await verifiedMapping('stripe',p.stripe,p),paypal:await verifiedMapping('paypal',p.paypal,p)};

  return transaction(async client=>{
    let tierId=id;
    const defaultPrice=pricing.prices[pricing.defaultCurrency];
    if(id){
      const updated=await client.query(`UPDATE reseller_tiers SET name=$2,description=$3,monthly_price_minor=$4,currency=$5,seat_limit=$6,grace_days=$7,sort_order=$8,visible=$9,active=$10,capacity_limit=$11,streams=$12,server_class=$13,placement_strategy=$14,allow_downloads=$15,allow_video_transcoding=$16,allow_audio_transcoding=$17,allow_remuxing=$18,allow_live_tv=$19,allow_live_tv_management=$20,allow_remote_access=$21,allow_4k=$22,library_access_mode=$23,library_names=$24::text[],updated_at=NOW() WHERE id=$1 RETURNING id`,[id,values.name,values.description,defaultPrice.priceMinor,pricing.defaultCurrency,values.seatLimit,values.graceDays,values.sortOrder,values.visible,values.active,values.capacityLimit,values.streams,values.serverClass,values.placementStrategy,values.downloads,values.video,values.audio,values.remux,values.live,values.liveManagement,values.remote,values.fourk,values.libraryMode,values.libraryNames]);
      if(!updated.rowCount)throw new Error('Reseller plan not found.');
    }else{
      tierId=(await client.query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,capacity_limit,streams,server_class,placement_strategy,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::text[]) RETURNING id`,[values.code,values.name,values.description,defaultPrice.priceMinor,pricing.defaultCurrency,values.seatLimit,values.graceDays,values.sortOrder,values.visible,values.active,values.capacityLimit,values.streams,values.serverClass,values.placementStrategy,values.downloads,values.video,values.audio,values.remux,values.live,values.liveManagement,values.remote,values.fourk,values.libraryMode,values.libraryNames])).rows[0].id;
    }

    await client.query(`UPDATE reseller_tier_prices SET active=FALSE,is_default=FALSE,updated_at=NOW() WHERE tier_id=$1`,[tierId]);
    for(const [c,p] of Object.entries(pricing.prices)){
      const savedPrice=await tierPricing.setPrice(client,tierId,{currency:c,priceMinor:p.priceMinor,active:true,isDefault:p.isDefault});
      for(const provider of ['stripe','paypal']){
        const external=p[provider],verified=verification[c][provider];
        if(!external){await client.query(`DELETE FROM reseller_tier_provider_prices WHERE tier_id=$1 AND tier_price_id=$2 AND provider=$3`,[tierId,savedPrice.id,provider]);continue}
        const vf=verified||{};
        await client.query(`INSERT INTO reseller_tier_provider_prices(tier_id,tier_price_id,provider,external_id,active,verified_at,verification_status,verification_error,remote_amount_minor,remote_currency,remote_interval,remote_active) VALUES($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tier_price_id,provider) DO UPDATE SET external_id=EXCLUDED.external_id,active=TRUE,verified_at=EXCLUDED.verified_at,verification_status=EXCLUDED.verification_status,verification_error=EXCLUDED.verification_error,remote_amount_minor=EXCLUDED.remote_amount_minor,remote_currency=EXCLUDED.remote_currency,remote_interval=EXCLUDED.remote_interval,remote_active=EXCLUDED.remote_active,updated_at=NOW()`,[tierId,savedPrice.id,provider,external,vf.verifiedAt||null,vf.verificationStatus||'unverified',vf.verificationError||null,vf.remoteAmountMinor??null,vf.remoteCurrency||null,vf.remoteInterval||null,vf.remoteActive??null]);
      }
    }
    await tierPricing.ensureDefault(client,tierId);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'reseller_tier',$3,$4::jsonb)`,[req.session.authUserId,id?'admin.reseller_tier.update':'admin.reseller_tier.create',tierId,JSON.stringify({code:values.code,name:values.name,seatLimit:values.seatLimit,streams:values.streams,defaultCurrency:pricing.defaultCurrency,currencies:Object.keys(pricing.prices)})]);
    return tierId;
  });
}

function createAdminResellerTiersRouter(){
  const r=express.Router();
  r.use('/admin/reseller-tiers',gate,noStore);
  r.use((req,res,next)=>req.method==='POST'?(csrf.verify(req)?next():res.status(403).send('Invalid security token')):next());
  r.get('/admin/reseller-tiers',async(req,res,next)=>{try{return res.send(await listPage(req))}catch(e){next(e)}});
  r.get('/admin/reseller-tiers/:id',async(req,res,next)=>{try{const page=await detailPage(req);return page?res.send(page):res.status(404).send('Plan not found')}catch(e){next(e)}});
  r.post('/admin/reseller-tiers',async(req,res)=>{try{const id=await saveTier(req);return redirect(res,`/admin/reseller-tiers/${id}`,'message','Reseller plan created. It remains closed while storefront availability is 0.')}catch(e){return redirect(res,'/admin/reseller-tiers','error',e.code==='23505'?'That code or payment mapping already exists.':e.message)}});
  r.post('/admin/reseller-tiers/manual-subscription',async(req,res)=>{try{await monthly.createManualTierSubscription({resellerId:req.body.resellerId,tierId:req.body.tierId,months:req.body.months,actorUserId:req.session.authUserId});return redirect(res,'/admin/reseller-tiers','message','Manual reseller subscription granted.')}catch(e){return redirect(res,'/admin/reseller-tiers','error',e.message)}});
  r.post('/admin/reseller-tiers/:id',async(req,res)=>{try{await saveTier(req,{id:req.params.id});return redirect(res,`/admin/reseller-tiers/${req.params.id}`,'message','Reseller plan saved. Managed users inherit the current Jellyfin policy.')}catch(e){return redirect(res,`/admin/reseller-tiers/${req.params.id}`,'error',e.message)}});
  r.post('/admin/reseller-tiers/:id/plans',(req,res)=>redirect(res,`/admin/reseller-tiers/${req.params.id}`,'message','Downstream customer-plan catalogues were removed. This reseller plan directly defines the managed Jellyfin user policy.'));
  return r;
}

async function savePlanRules(){throw new Error('Downstream reseller plan rules have been retired. Configure the Jellyfin policy directly on the reseller plan.')}
async function planMatrix(){return{plans:[],rules:new Map(),explicit:false,mode:'retired'}}

module.exports={createAdminResellerTiersRouter,tierRows,commercialMrr,saveTier,savePlanRules,planMatrix,tierForm,detailPage};