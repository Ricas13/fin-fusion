'use strict';
const express=require('express');
const {query}=require('../db');
const customers=require('../customers');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const plisio=require('../payments/plisio');
const discounts=require('../payments/discounts');
const publicError=require('./public-error');
const moneyFormat=require('./money-format');
const planPricing=require('../payments/plan-pricing');
const accessVariants=require('../payments/stream-variants');
const variantCapacity=require('../payments/access-variant-capacity');
const billingMode=require('../payments/subscription-billing-mode');
const provisioning=require('../jellyfin/resilient-provisioning');
const customerAccessState=require('../access/customer-access-state');
const stremioEntitlements=require('../stremio/entitlements');
const householdAccess=require('../stremio/household-access');
const installRecovery=require('../stremio/install-credential-recovery');
const cleanupReturn=require('../entitlements/jellyfin-cleanup-return');
const requestUserSync=require('../integrations/request-user-sync');
const notificationSettings=require('../integrations/notification-settings');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const customerNav=require('./customer-nav-html');
const productReadiness=require('./product-readiness');
const checkoutIntents=require('../payments/checkout-intents');
const planChange=require('../payments/customer-plan-change');
const csrf=require('../auth/csrf');
const customerServerChoice=require('../jellyfin/customer-server-choice');

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));}
async function hideInternalAccounts(_customerId,portal){if(!portal||!Array.isArray(portal.accounts))return portal;portal.accounts=portal.accounts.filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal');return portal;}
async function tagMediaServerAccounts(customerId,portal){if(!portal||!Array.isArray(portal.accounts)||!portal.accounts.length)return portal;const result=await query(`SELECT ja.id,COALESCE(js.media_server_type,'jellyfin') AS media_server_type FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1`,[customerId]);const map=new Map(result.rows.map(row=>[String(row.id),String(row.media_server_type||'jellyfin')]));portal.accounts=portal.accounts.map(account=>({...account,media_server_type:map.get(String(account.id))||'jellyfin'}));return portal;}
function deliveryType(entitlement){return productReadiness.serviceType({service_type:entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin'});}
function recurringProvider(row){return billingMode.recurringProvider(row);}
function subscriptionId(row){return row&&(row.subscription_id||row.id)?String(row.subscription_id||row.id):null;}
function canonicalAccessRows(_portal,{currentPlan=null,freePlan=null,stremioPlan=null,embyPlan=null,entitlements=[],excludeSubscriptionIds=[]}={}){
  const rowsById=new Map(),excludedIds=new Set((excludeSubscriptionIds||[]).map(String).filter(Boolean));
  function add(row){
    const id=subscriptionId(row);if(!id||excludedIds.has(id)||row?.is_addon)return;
    rowsById.set(id,{...(rowsById.get(id)||{}),...row,id,subscription_id:id});
  }
  for(const entitlement of [freePlan,currentPlan,stremioPlan,embyPlan,...(Array.isArray(entitlements)?entitlements:[])])add(entitlement);
  return Array.from(rowsById.values());
}
function plansFromAccessSnapshot(snapshot={}) {
  return {
    currentPlan:snapshot?.primary?.entitlement||null,
    freePlan:snapshot?.free?.entitlement||null,
    stremioPlan:snapshot?.stremio?.entitlement||null,
    embyPlan:snapshot?.emby?.entitlement||null
  };
}
function canonicalizePortalSubscriptions(portal,accessRows){
  if(!portal)return portal;
  portal.subscriptions=Array.isArray(accessRows)?accessRows.slice():[];
  return portal;
}
function livePlanIds(rows){return new Set((Array.isArray(rows)?rows:[]).map(row=>String(row.plan_id||'')).filter(Boolean));}
function variantPaymentOptions(variant,enabled){return(Array.isArray(variant?.payment_options)?variant.payment_options:[]).filter(option=>enabled[option.provider]).map(option=>({provider:option.provider,checkoutMode:option.checkoutMode||option.checkout_mode||'payment'}));}
function priceLabel(minor,currency){return moneyFormat.formatMinor(minor,currency||'GBP');}
function homeCataloguePlans(plans,includePlanIds=[]){const keep=new Set((includePlanIds||[]).map(String));return(Array.isArray(plans)?plans:[]).filter(plan=>plan.is_free_tier||!plan.capacity?.soldOut||keep.has(String(plan.id)));}
function readySalePlans(plans,includePlanIds=[]){const keep=new Set((includePlanIds||[]).map(String));return homeCataloguePlans(plans,includePlanIds).filter(plan=>plan.sale_ready!==false||keep.has(String(plan.id)));}

async function catalogPlans(){
  const currency=await planPricing.platformDefaultCurrency(),logical=await customers.listPublicPlans(),priced=await planPricing.decoratePlans(logical,null),decorated=await accessVariants.decoratePlans(priced,currency),ctx=await productReadiness.context(),evaluated=await Promise.all(decorated.map(async plan=>({plan,readiness:await productReadiness.evaluatePlan(plan,ctx)})));
  const catalogue=evaluated.map(({plan,readiness})=>({...plan,sale_ready:Boolean(readiness.sellable),sale_readiness:readiness,payment_options:readiness.sellable?plan.payment_options:[]}));
  return variantCapacity.decoratePlans(catalogue);
}
async function sellablePlans(includePlanIds=[]){return readySalePlans(await catalogPlans(),includePlanIds);}
function accountForEntitlement(portal,entitlement){
  if(!Array.isArray(portal?.accounts)||!entitlement)return null;
  const lane=entitlement.is_free_tier?'free':'primary';
  const candidates=portal.accounts.filter(account=>String(account.media_server_type||'jellyfin')==='jellyfin'&&account.access_lane===lane);
  const assignedServerId=String(entitlement.admin_forced_server_id||entitlement.media_server_id||'').trim();
  if(assignedServerId){
    return candidates.find(account=>String(account.server_id||'')===assignedServerId&&!account.disabled)
      ||candidates.find(account=>String(account.server_id||'')===assignedServerId)
      ||null;
  }
  const enabled=candidates.filter(account=>!account.disabled);
  if(enabled.length===1)return enabled[0];
  return candidates.length===1?candidates[0]:null;
}
function onboardingMessage(portal,currentPlan){if(!currentPlan||!['jellyfin','bundle'].includes(deliveryType(currentPlan)))return null;const account=accountForEntitlement(portal,currentPlan);if(!account||account.disabled||account.last_activity_at)return null;const username=account.jellyfin_username||portal.customer?.login_username||'your Jellyfin username';if(account.password_setup_required)return 'Your Jellyfin account is ready. Choose your password below to start watching.';return `Your Jellyfin account is ready. Open Jellyfin and sign in as ${username}.`;}
function customerProvisioningMessage(state){const message=String(state?.last_error||'');if(/no eligible (?:jellyfin|emby) server|no (?:jellyfin|emby) server|no suitable server/i.test(message))return 'No suitable streaming server is available for this plan right now. We will retry automatically, or you can retry now.';if(/username .* already exists|target_username_exists/i.test(message))return 'That streaming username is already in use on the target server. Please retry; if it continues, contact support.';if(/capacity|max_users|sold out/i.test(message))return 'The eligible streaming server is currently at capacity. We will retry automatically when space is available.';if(state&&['blocked','failed','pending','running'].includes(String(state.status||'')))return 'One of your streaming services is still being prepared. CAPTAiNFiN will keep retrying automatically.';return null;}
function stremioDeepLink(manifestUrl){if(!manifestUrl)return null;const url=new URL(manifestUrl);return `stremio://${url.host}${url.pathname}${url.search}`;}
async function stremioLinks(req,customerId,hasStremio){if(!hasStremio)return{manifestUrl:null,installUrl:null};let recovered;try{recovered=await installRecovery.current(customerId);}catch(error){console.warn('Customer Stremio installation link lookup failed:',{customerId,error:error.message});return{manifestUrl:null,installUrl:null};}if(!recovered?.credential)return{manifestUrl:null,installUrl:null};const manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(recovered.credential)}/manifest.json`);return{manifestUrl,installUrl:stremioDeepLink(manifestUrl)};}
async function stremioHouseholdForCustomer(customerId,hasStremio){if(!hasStremio)return null;try{const row=await stremioEntitlements.current(customerId);if(!row)return null;const configured=await householdAccess.configForEntitlement(row),limit=Math.max(1,Number(configured.component.config.networkLimit||1)),status=String(row.status||'pending'),replacementState=status==='active'?await householdAccess.replacementState(row):null;return{status,accessModel:`Unlimited streams · Unlimited devices · ${limit} household connection${limit===1?'':'s'}`,replacementState:replacementState?{...replacementState,message:replacementState.allowed?'You can change the registered household connection now.':householdAccess.cooldownMessage(replacementState)}:null};}catch(error){console.warn('Customer Stremio household status unavailable:',{customerId,error:error.message});return null;}}
async function libraryProfilesForPortal(customerId,portal){const profiles=[];for(const account of Array.isArray(portal?.accounts)?portal.accounts:[]){if(account.disabled||String(account.media_server_type||'jellyfin')!=='jellyfin')continue;try{const profile=await provisioning.libraryPolicyForAccount(customerId,account);if(!profile.entitlement?.allow_customer_library_choice||!profile.effective)continue;const available=profile.effective.entitlementRows.filter(row=>row.effective).map(row=>row.name);if(!available.length)continue;profiles.push({accountId:account.id,serverName:account.server_name||'Jellyfin server',username:account.jellyfin_username||'',accessLane:account.access_lane||'primary',available,selected:profile.effective.visibleNames});}catch(error){console.warn('Customer Jellyfin library profile unavailable:',{customerId,accountId:account.id,error:error.message});}}return profiles;}
async function discountPreview(customerId,rawCode){const code=discounts.normalizeCode(rawCode);if(!code)return{code:'',valid:false,plans:{},message:null};const plans=await sellablePlans(),out={},errors=[];for(const plan of plans.filter(plan=>Number(plan.price_minor||0)>0)){try{const discount=await discounts.validateForCheckout({code,planId:plan.id,planCode:plan.code,customerId,currency:plan.currency}),baseMinor=Number(plan.price_minor||0),finalMinor=discounts.computeDiscountedMinor(baseMinor,discount);out[plan.code]={valid:true,baseMinor,finalMinor,currency:plan.currency||'USD',discountType:discount?.discount_type||null,percentOff:Number(discount?.percent_off||0),fixedOffMinor:Number(discount?.fixed_off_minor||0)};}catch(error){out[plan.code]={valid:false};errors.push(error.message);}}const valid=Object.values(out).some(row=>row.valid);return{code,valid,plans:out,message:valid?'Promo applied to eligible plan prices below. Stripe subscription promos reduce the first payment; PayPal recurring plans cannot be dynamically repriced, so a promo uses PayPal one-time checkout.':errors[0]||'That promo code is not valid for the available plans.'};}

async function customerVariantState(customerId){
  const plans=(await catalogPlans()).filter(plan=>plan.sale_ready!==false),enabled={stripe:stripe.enabled(),paypal:paypal.enabled(),plisio:plisio.enabled()};
  return Promise.all(plans.filter(plan=>Array.isArray(plan.access_variants)&&plan.access_variants.length>1).map(async plan=>{
    const current=await planChange.currentRecurring(customerId,plan).catch(()=>null),samePlan=Boolean(current&&String(current.plan_id)===String(plan.id)),kind=plan.access_variant_kind||accessVariants.variantKind(plan),currentQuantity=samePlan?planChange.subscriptionAccessQuantity(current,kind):null,currentProvider=recurringProvider(current),preferred=plan.preferred_access_variant||plan.access_variants.find(v=>!v.capacity?.soldOut)||plan.access_variants[0];
    const variants=plan.access_variants.map(variant=>{const quantity=variantCapacity.variantQuantity(plan,variant),replacementFits=Boolean(samePlan&&currentQuantity&&quantity<=currentQuantity),soldOut=Boolean(variant.capacity?.soldOut&&!replacementFits);return{quantity,kind:variant.variant_kind||kind,priceMinor:Number(variant.price_minor||0),currency:variant.currency||plan.currency,priceLabel:priceLabel(variant.price_minor,variant.currency||plan.currency),soldOut,scarcity:soldOut?(variant.capacity?.label||'Currently full'):(replacementFits&&variant.capacity?.soldOut?'Available as a reduction':variant.capacity?.label||'Available'),paymentOptions:variantPaymentOptions(variant,enabled)};});
    const preferredQuantity=samePlan&&variants.some(v=>v.quantity===currentQuantity)?currentQuantity:variantCapacity.variantQuantity(plan,preferred);
    return{planId:plan.id,code:plan.code,name:plan.name,kind,preferredQuantity,currentPlan:samePlan,currentQuantity,currentProvider,currentCancelAtPeriodEnd:Boolean(current?.cancel_at_period_end),currentPriceMinor:current?Number(current.price_minor_snapshot??current.price_minor??0):null,variants};
  }));
}

function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function recentFreeInactivityRemoval(customerId){
  const result=await query(`
    SELECT a.created_at
    FROM audit_log a
    WHERE a.entity_type='customer'
      AND a.entity_id=$1
      AND a.action IN ('customer.inactivity.remove_jellyfin','customer.inactivity.finalize_free_plan')
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.customer_id=$1
          AND s.created_at>a.created_at
      )
    ORDER BY a.created_at DESC
    LIMIT 1
  `,[customerId]);
  return result.rows[0]||null;
}
function returningAccessPage(req,status){const site=runtimeSettings.siteName(),copy='A Jellyfin profile tied to your current active plan was cleaned up while inactive. You can restore that profile without changing your plan.';return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Restore access · ${esc(site)}</title><link rel="icon" href="/branding/favicon"><link rel="stylesheet" href="/css/customer-portal.css"><style>body{margin:0;background:#0d1117;color:#e8edf3}.restoreMain{width:min(580px,calc(100% - 28px));margin:0 auto;padding:48px 0}.restoreCard{padding:24px}.restoreActions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.plainForm{margin:0}</style></head><body><main class="restoreMain"><section class="panel restoreCard"><div class="eyebrow">Welcome back</div><h1>Restore Jellyfin profile?</h1><p>${esc(copy)}</p><p class="accessMeta">Opening this page did not change your account or contact Jellyfin. Restoration only starts when you choose Restore profile.</p><p class="accessMeta">This option is only for a profile cleanup on an active plan. Free Server access removed for inactivity is not retained or restorable.</p><div class="restoreActions"><form class="plainForm" method="post" action="/account/provisioning/retry"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button primary" type="submit">Restore profile</button></form><a class="button secondary" href="/account?skipRestore=1">Continue without restoring</a></div></section></main></body></html>`;}

function createCustomerDashboardRouter(){
  const r=express.Router();
  r.get('/account/discount-preview',requireCustomer,async(req,res)=>{try{return res.json(await discountPreview(req.session.customerId,req.query.code));}catch(error){const{message,status}=publicError.present(error,{context:'Discount preview failed',fallback:'Promo code could not be checked.'});return res.status(status).json({valid:false,plans:{},message});}});
  r.get('/account/plan-variants',requireCustomer,async(req,res)=>{try{res.setHeader('Cache-Control','no-store, private, max-age=0');return res.json({plans:await customerVariantState(req.session.customerId)});}catch(error){console.warn('Customer plan variant state failed:',error.message);return res.status(503).json({plans:[],error:'Plan options are temporarily unavailable.'});}});
  r.get('/account/media-locations',requireCustomer,async(req,res)=>{try{
    res.setHeader('Cache-Control','no-store, private, max-age=0');
    const planCode=String(req.query.planCode||'').trim();
    if(!planCode)return res.status(400).json({media:false,requiresSelection:false,locations:[],error:'Plan is required.'});
    const found=await query(`SELECT * FROM plans WHERE code=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND audience IN('direct','both') AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) LIMIT 1`,[planCode]);
    if(!found.rowCount)return res.status(404).json({media:false,requiresSelection:false,locations:[],error:'Plan is not available.'});
    const plan=found.rows[0],media=Boolean(customerServerChoice.mediaServerType(plan));
    if(!media)return res.json({media:false,requiresSelection:false,locations:[]});
    const locations=await customerServerChoice.choicesForPlan(plan);
    let selectedLocation=null;
    const current=await planChange.currentRecurring(req.session.customerId,plan).catch(()=>null);
    if(current?.media_server_id){
      const assigned=await customerServerChoice.existingAssignedServerForPlan(plan,current.media_server_id,null).catch(()=>null);
      if(assigned){
        selectedLocation=assigned.selected_location||customerServerChoice.locationLabel(assigned.location);
        if(!locations.some(location=>String(location.value)===String(selectedLocation))){
          locations.push({
            value:selectedLocation,
            label:selectedLocation,
            remaining:0,
            serverCount:1,
            testUrl:await customerServerChoice.safeTestUrl(assigned),
            existingAssignment:true
          });
        }
      }
    }
    locations.sort((a,b)=>String(a.label||a.value).localeCompare(String(b.label||b.value)));
    return res.json({media:true,requiresSelection:locations.length>1,selectedLocation,locations});
  }catch(error){console.warn('Customer media location state failed:',error.message);return res.status(503).json({media:true,requiresSelection:false,locations:[],error:'Server locations are temporarily unavailable.'});}});
  r.get('/account/free-access',requireCustomer,async(req,res,next)=>{
    try{
      const customerId=req.session.customerId;
      const returnStatus=await cleanupReturn.returningCustomerStatus(customerId).catch(error=>({eligible:false,error:error.message}));
      if(returnStatus.eligible)return res.redirect('/account');
      const freeAccess=await customerAccessState.freeJellyfin(customerId,{includeBlocked:true});
      const freePlan=freeAccess.entitlement;
      if(freePlan){
        if(freeAccess.state===customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED){
          const inactivityRemoval=await recentFreeInactivityRemoval(customerId).catch(()=>null);
          if(inactivityRemoval){
            const message='Your previous Free Server access was removed because of inactivity. You do not have an active Free Server plan and there is nothing reserved to restore. Choose an available plan below if you want access again.';
            return res.redirect('/account?message='+encodeURIComponent(message)+'#plans');
          }
          const reason=returnStatus.error?'Your Free Access status could not be checked safely. Open My Access or contact support instead of creating another account.':'Your existing Free Access is currently restricted. Open My Access instead of creating another account.';
          return res.redirect('/account/access?error='+encodeURIComponent(reason));
        }
        if(freeAccess.state===customerAccessState.ACCESS_STATES.ACTIVE_READY)return res.redirect('/account/access?message='+encodeURIComponent('Your Free Access is already active.'));
        return res.redirect('/account?message='+encodeURIComponent('You do not currently have a Free Server plan. Choose an available plan below if you want access again.')+'#plans');
      }
      const message=returnStatus.error?'You are signed in. We could not verify your current Free Access state, but you can use an available Free Server plan below.':'You are signed in. If a Free Server place is available, choose the Free Server option below.';
      return res.redirect('/account?message='+encodeURIComponent(message)+'#plans');
    }catch(error){return next(error);}
  });
  r.get('/account',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const customerId=req.session.customerId;
      const returnStatus=await cleanupReturn.returningCustomerStatus(customerId).catch(error=>({eligible:false,error:error.message}));
      if(returnStatus.eligible&&req.query.skipRestore!=='1'){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');return res.send(returningAccessPage(req,returnStatus));}
      const [portal,currency,requestAccess,requestConfig,rawProvisioningState,renewalSubscription,openPlanChange,deliverySettings]=await Promise.all([
        customers.getCurrentCustomerPortal(customerId),
        planPricing.platformDefaultCurrency(),
        requestUserSync.requestAccessForCustomer(customerId),
        requestUserSync.configuration(),
        provisioning.control.getCustomerState(customerId).catch(()=>null),
        planChange.currentRecurring(customerId).catch(()=>null),
        planChange.pendingForCustomer(customerId).catch(()=>null),
        notificationSettings.status().catch(()=>({}))
      ]);
      if(!portal)throw new Error('Customer portal state is unavailable.');
      const accessSnapshot=portal.accessSnapshot,primaryAccess=accessSnapshot.primary,freeAccess=accessSnapshot.free,stremioAccess=accessSnapshot.stremio,embyAccess=accessSnapshot.emby;
      let {currentPlan,freePlan,stremioPlan,embyPlan}=plansFromAccessSnapshot(accessSnapshot);
      if(primaryAccess.state===customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED)currentPlan=null;
      if(freeAccess.state===customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED)freePlan=null;
      if(stremioAccess.state===customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED)stremioPlan=null;
      let effectiveFreePlan=freePlan,incompleteFreePlan=false,incompleteFreeSubscriptionId=null;
      if(effectiveFreePlan&&!effectiveFreePlan.blocked&&freeAccess.state!==customerAccessState.ACCESS_STATES.ACTIVE_READY){
        incompleteFreePlan=true;
        incompleteFreeSubscriptionId=subscriptionId(effectiveFreePlan);
        effectiveFreePlan=null;
      }
      const effectiveCurrentPlan=incompleteFreeSubscriptionId&&subscriptionId(currentPlan)===incompleteFreeSubscriptionId?null:currentPlan;
      const accessRows=canonicalAccessRows(portal,{currentPlan:effectiveCurrentPlan,freePlan:effectiveFreePlan,stremioPlan,embyPlan,excludeSubscriptionIds:incompleteFreeSubscriptionId?[incompleteFreeSubscriptionId]:[]}),allPlans=await catalogPlans(),includedPlanIds=Array.from(livePlanIds(accessRows)),plans=accessRows.length||openPlanChange?homeCataloguePlans(allPlans,includedPlanIds):readySalePlans(allPlans,includedPlanIds);
      const navOptions=customerNav.optionsFromPortal(portal);
      const paymentFlags={stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),plisioEnabled:plisio.enabled()},openCheckout=await checkoutIntents.getOpenForOwner('customer',customerId).catch(()=>null);
      if(!accessRows.length&&!openPlanChange){
        const inactivityRemoval=await recentFreeInactivityRemoval(customerId).catch(()=>null);
        const noPlanMessage=inactivityRemoval
          ?'Your Free Server access was removed because of inactivity. You now have no active Free Server plan. There is nothing reserved to restore; choose an available plan below if you want access again.'
          :incompleteFreePlan
            ?'You do not currently have a Free Server plan. Choose an available plan below if you want access again.'
            :null;
        return res.render('customer/onboarding',{portal,plans,...paymentFlags,currency,openCheckout,navOptions,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||noPlanMessage,error:req.query.error||returnStatus.error||null,discordInviteUrl:deliverySettings.discordInviteUrl||''});
      }
      const jellyfinPlan=effectiveCurrentPlan||effectiveFreePlan||null,delivery=deliveryType(jellyfinPlan),hasJellyfin=Boolean(jellyfinPlan&&['jellyfin','bundle'].includes(delivery)),hasStremio=Boolean(stremioPlan),hasEmby=Boolean(embyPlan&&!embyPlan.blocked),jellyfinAccounts=portal.accounts.filter(account=>String(account.media_server_type||'jellyfin')==='jellyfin'),embyAccounts=portal.accounts.filter(account=>String(account.media_server_type||'jellyfin')==='emby'),[links,stremioHousehold]=await Promise.all([stremioLinks(req,customerId,hasStremio),stremioHouseholdForCustomer(customerId,hasStremio)]),provisioningState=rawProvisioningState?{...rawProvisioningState,last_error:customerProvisioningMessage(rawProvisioningState)}:null,libraryProfiles=await libraryProfilesForPortal(customerId,portal),welcome=onboardingMessage({...portal,accounts:jellyfinAccounts},jellyfinPlan),message=req.query.message||welcome||null;
      return res.render('customer/dashboard',{portal,plans,currentAccessRows:accessRows,currentPlan:jellyfinPlan,freePlan:effectiveFreePlan,stremioPlan,embyPlan,renewalSubscription,openPlanChange,openCheckout,...paymentFlags,currency,navOptions,overseerrUrl:runtimeSettings.overseerrUrl(),requestAccess,requestSyncConfigured:requestConfig.configured,libraryProfiles,provisioningState,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message,error:req.query.error||returnStatus.error||null,welcome:req.query.welcome==='1',hasJellyfin,hasStremio,hasEmby,jellyfinAccounts,embyAccounts,stremioHousehold,stremioInstallUrl:links.installUrl,stremioManifestUrl:links.manifestUrl,discordInviteUrl:deliverySettings.discordInviteUrl||'',stremioMetadataAddonUrl:deliverySettings.stremioMetadataAddonUrl||''});
    }catch(error){return next(error);}
  });
  r.post('/account/provisioning/retry',requireCustomer,async(req,res)=>{if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));try{const customerId=req.session.customerId,restored=await cleanupReturn.restoreReturningCustomer(customerId,{reconcile:provisioning.reconcileCustomer});if(restored.restored)return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your Jellyfin access has been restored.'));const outcome=await provisioning.reconcileCustomer(customerId);if(outcome?.active&&(outcome?.account?.id||outcome?.emby?.account?.id||outcome?.stremio?.status==='active'))return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your streaming access has been refreshed.'));const state=await provisioning.control.getCustomerState(customerId).catch(()=>null),safe=customerProvisioningMessage(state)||'Your streaming access has not completed yet. We will keep retrying automatically.';return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));}catch(error){const safe=customerProvisioningMessage({status:'failed',last_error:error?.message||error})||'Your streaming access has not completed yet. We will keep retrying automatically.';return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));}});
  return r;
}
module.exports={createCustomerDashboardRouter,hideInternalAccounts,tagMediaServerAccounts,deliveryType,catalogPlans,sellablePlans,homeCataloguePlans,readySalePlans,customerVariantState,recurringProvider,canonicalAccessRows,plansFromAccessSnapshot,canonicalizePortalSubscriptions,onboardingMessage,customerProvisioningMessage,stremioDeepLink,stremioLinks,stremioHouseholdForCustomer,libraryProfilesForPortal,discountPreview,recentFreeInactivityRemoval,returningAccessPage};