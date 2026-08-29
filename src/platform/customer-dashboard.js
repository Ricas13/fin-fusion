'use strict';
const express=require('express');
const {query}=require('../db');
const customers=require('../customers');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const plisio=require('../payments/plisio');
const discounts=require('../payments/discounts');
const publicError=require('./public-error');
const planPricing=require('../payments/plan-pricing');
const accessVariants=require('../payments/stream-variants');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('../entitlements/subscription-state');
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
const planCapacity=require('../entitlements/plan-capacity');
const checkoutIntents=require('../payments/checkout-intents');
const planChange=require('../payments/customer-plan-change');
const csrf=require('../auth/csrf');
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));}
async function hideInternalAccounts(_customerId,portal){if(!portal||!Array.isArray(portal.accounts))return portal;portal.accounts=portal.accounts.filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal');return portal;}
function deliveryType(entitlement){return productReadiness.serviceType({service_type:entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin'});}
function fallbackCapacity(plan){return{limit:plan.capacity_limit??null,used:0,reserved:0,remaining:plan.capacity_limit??null,soldOut:false,label:'Available',kind:'available'};}
async function sellablePlans(){const currency=await planPricing.platformDefaultCurrency(),logical=await customers.listPublicPlans(),priced=await planPricing.decoratePlans(logical,null),decorated=await accessVariants.decoratePlans(priced,currency),ctx=await productReadiness.context(),ready=decorated.filter(plan=>productReadiness.evaluate(plan,ctx).sellable),enriched=[];for(const plan of ready){const capacity=await planCapacity.usage(plan.id).catch(()=>fallbackCapacity(plan));let variants=Array.isArray(plan.access_variants)?plan.access_variants:[];if(variants.length)variants=await Promise.all(variants.map(async variant=>{const quantity=Number(variant.access_quantity||variant.quantity||1),capacityOptions=variant.variant_kind==='households'?{households:quantity}:{streams:quantity};return{...variant,capacity:await planCapacity.usage(plan.id,undefined,capacityOptions).catch(()=>capacity)};}));enriched.push({...plan,capacity,access_variants:variants});}return enriched.filter(plan=>plan.is_free_tier||!plan.capacity.soldOut);}
function accountForEntitlement(portal,entitlement){if(!Array.isArray(portal?.accounts)||!entitlement)return null;const lane=entitlement.is_free_tier?'free':'primary';return portal.accounts.find(a=>a.access_lane===lane&&!a.disabled)||portal.accounts.find(a=>a.access_lane===lane)||null;}
function onboardingMessage(portal,currentPlan){if(!currentPlan||!['jellyfin','bundle'].includes(deliveryType(currentPlan)))return null;const account=accountForEntitlement(portal,currentPlan);if(!account||account.disabled||account.last_activity_at)return null;const username=account.jellyfin_username||portal.customer?.login_username||'your Jellyfin username';if(account.password_setup_required)return 'Your Jellyfin account is ready. Choose your password below to start watching.';return `Your Jellyfin account is ready. Open Jellyfin and sign in as ${username}.`;}
function customerProvisioningMessage(state){const message=String(state?.last_error||'');if(/no eligible jellyfin server|no jellyfin server|no suitable server/i.test(message))return 'No suitable Jellyfin server is available for this plan right now. We will retry automatically, or you can retry now.';if(/username .* already exists|target_username_exists/i.test(message))return 'That Jellyfin username is already in use on the target server. Please retry; if it continues, contact support.';if(/capacity|max_users|sold out/i.test(message))return 'The eligible Jellyfin server is currently at capacity. We will retry automatically when space is available.';if(state&&['blocked','failed','pending','running'].includes(String(state.status||'')))return 'One of your streaming services is still being prepared. CAPTAiNFiN will keep retrying automatically.';return null;}
function stremioDeepLink(manifestUrl){if(!manifestUrl)return null;const url=new URL(manifestUrl);return `stremio://${url.host}${url.pathname}${url.search}`;}
async function stremioLinks(req,customerId,hasStremio){
  if(!hasStremio)return{manifestUrl:null,installUrl:null};
  let recovered;
  try{recovered=await installRecovery.current(customerId);}catch(error){console.warn('Customer Stremio installation link lookup failed:',{customerId,error:error.message});return{manifestUrl:null,installUrl:null};}
  if(!recovered?.credential)return{manifestUrl:null,installUrl:null};
  const manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(recovered.credential)}/manifest.json`);
  return{manifestUrl,installUrl:stremioDeepLink(manifestUrl)};
}
async function stremioHouseholdForCustomer(customerId,hasStremio){
  if(!hasStremio)return null;
  try{const row=await stremioEntitlements.current(customerId);if(!row)return null;const configured=await householdAccess.configForEntitlement(row),limit=Math.max(1,Number(configured.component.config.networkLimit||1)),status=String(row.status||'pending'),replacementState=status==='active'?await householdAccess.replacementState(row):null;return{status,accessModel:`Unlimited streams · Unlimited devices · ${limit} household connection${limit===1?'':'s'}`,replacementState:replacementState?{...replacementState,message:replacementState.allowed?'You can change the registered household connection now.':householdAccess.cooldownMessage(replacementState)}:null};}
  catch(error){console.warn('Customer Stremio household status unavailable:',{customerId,error:error.message});return null;}
}
async function libraryProfilesForPortal(customerId,portal){
  const profiles=[];
  for(const account of Array.isArray(portal?.accounts)?portal.accounts:[]){
    if(account.disabled)continue;
    try{const profile=await provisioning.libraryPolicyForAccount(customerId,account);if(!profile.entitlement?.allow_customer_library_choice||!profile.effective)continue;const available=profile.effective.entitlementRows.filter(row=>row.effective).map(row=>row.name);if(!available.length)continue;profiles.push({accountId:account.id,serverName:account.server_name||'Jellyfin server',username:account.jellyfin_username||'',accessLane:account.access_lane||'primary',available,selected:profile.effective.visibleNames});}
    catch(error){console.warn('Customer Jellyfin library profile unavailable:',{customerId,accountId:account.id,error:error.message});}
  }
  return profiles;
}
async function discountPreview(customerId,rawCode){const code=discounts.normalizeCode(rawCode);if(!code)return{code:'',valid:false,plans:{},message:null};const plans=await sellablePlans(),out={},errors=[];for(const plan of plans.filter(plan=>Number(plan.price_minor||0)>0)){try{const discount=await discounts.validateForCheckout({code,planId:plan.id,planCode:plan.code,customerId}),baseMinor=Number(plan.price_minor||0),finalMinor=discounts.computeDiscountedMinor(baseMinor,discount);out[plan.code]={valid:true,baseMinor,finalMinor,currency:plan.currency||'USD',discountType:discount?.discount_type||null,percentOff:Number(discount?.percent_off||0),fixedOffMinor:Number(discount?.fixed_off_minor||0)};}catch(error){out[plan.code]={valid:false};errors.push(error.message);}}const valid=Object.values(out).some(row=>row.valid);return{code,valid,plans:out,message:valid?'Promo applied to eligible plan prices below. Stripe subscription promos reduce the first payment; PayPal recurring plans cannot be dynamically repriced, so a promo uses PayPal one-time checkout.':errors[0]||'That promo code is not valid for the available plans.'};}
function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function returningAccessPage(req,status){const site=runtimeSettings.siteName(),copy=status.canRestoreDeletedFree?'Your Free Server profile was removed after inactivity, but your Free Access entitlement is still available. Restore it to create fresh Jellyfin access.':'A previous Jellyfin profile was cleaned up while inactive. You can restore streaming access now.';return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Restore access · ${esc(site)}</title><link rel="icon" href="/branding/favicon"><link rel="stylesheet" href="/css/customer-portal.css"><style>body{margin:0;background:#0d1117;color:#e8edf3}.restoreMain{width:min(580px,calc(100% - 28px));margin:0 auto;padding:48px 0}.restoreCard{padding:24px}.restoreActions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.plainForm{margin:0}</style></head><body><main class="restoreMain"><section class="panel restoreCard"><div class="eyebrow">Welcome back</div><h1>Restore Jellyfin access?</h1><p>${esc(copy)}</p><p class="accessMeta">Opening this page did not change your account or contact Jellyfin. Restoration only starts when you choose Restore access.</p><div class="restoreActions"><form class="plainForm" method="post" action="/account/provisioning/retry"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button primary" type="submit">Restore access</button></form><a class="button secondary" href="/account?skipRestore=1">Continue without restoring</a></div></section></main></body></html>`;}

function createCustomerDashboardRouter(){
  const r=express.Router();
  r.get('/account/discount-preview',requireCustomer,async(req,res)=>{try{return res.json(await discountPreview(req.session.customerId,req.query.code));}catch(error){const{message,status}=publicError.present(error,{context:'Discount preview failed',fallback:'Promo code could not be checked.'});return res.status(status).json({valid:false,plans:{},message});}});
  r.get('/account',requireCustomer,async(req,res,next)=>{
    try{
      await runtimeSettings.ensureLoaded();
      const customerId=req.session.customerId;
      // Page rendering may inspect whether a previously-cleaned entitlement can
      // be restored, but GET /account must never release holds or contact a
      // remote Jellyfin server. Restoration belongs to the CSRF-protected POST
      // retry action below.
      const returnStatus=await cleanupReturn.returningCustomerStatus(customerId).catch(error=>({eligible:false,error:error.message}));
      if(returnStatus.eligible&&req.query.skipRestore!=='1'){
        res.setHeader('Cache-Control','no-store, private, max-age=0');
        res.setHeader('Pragma','no-cache');
        return res.send(returningAccessPage(req,returnStatus));
      }
      const currency=await planPricing.platformDefaultCurrency();
      const [portalRaw,plans,currentPlan,freePlan,stremioPlan,requestAccess,requestConfig,rawProvisioningState,renewalSubscription,openPlanChange,deliverySettings]=await Promise.all([
        customers.getCustomerPortal(customerId),
        sellablePlans(),
        provisioning.currentEntitlement(customerId),
        subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true}),
        stremioEntitlements.entitledSubscription(customerId),
        requestUserSync.requestAccessForCustomer(customerId),
        requestUserSync.configuration(),
        provisioning.control.getCustomerState(customerId).catch(()=>null),
        planChange.currentRecurring(customerId).catch(()=>null),
        planChange.pendingForCustomer(customerId).catch(()=>null),
        notificationSettings.status().catch(()=>({}))
      ]);
      const portal=await hideInternalAccounts(customerId,portalRaw),navOptions=customerNav.optionsFromPortal(portal),paymentFlags={stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),plisioEnabled:plisio.enabled()};
      if(!currentPlan&&!freePlan&&!stremioPlan&&!openPlanChange){
        const openCheckout=await checkoutIntents.getOpenForOwner('customer',customerId).catch(()=>null);
        return res.render('customer/onboarding',{portal,plans,...paymentFlags,currency,openCheckout,navOptions,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message:req.query.message||null,error:req.query.error||returnStatus.error||null,discordInviteUrl:deliverySettings.discordInviteUrl||''});
      }
      const jellyfinPlan=currentPlan||freePlan||null,delivery=deliveryType(jellyfinPlan),hasJellyfin=Boolean(jellyfinPlan&&['jellyfin','bundle'].includes(delivery)),hasStremio=Boolean(stremioPlan),[links,stremioHousehold]=await Promise.all([stremioLinks(req,customerId,hasStremio),stremioHouseholdForCustomer(customerId,hasStremio)]),provisioningState=rawProvisioningState?{...rawProvisioningState,last_error:customerProvisioningMessage(rawProvisioningState)}:null,libraryProfiles=await libraryProfilesForPortal(customerId,portal),welcome=onboardingMessage(portal,jellyfinPlan),message=req.query.message||welcome||null;
      return res.render('customer/dashboard',{portal,plans,currentPlan:jellyfinPlan,freePlan,stremioPlan,renewalSubscription,openPlanChange,...paymentFlags,currency,navOptions,overseerrUrl:runtimeSettings.overseerrUrl(),requestAccess,requestSyncConfigured:requestConfig.configured,libraryProfiles,provisioningState,csrfToken:csrf.token(req),siteName:runtimeSettings.siteName(),message,error:req.query.error||returnStatus.error||null,welcome:req.query.welcome==='1',hasJellyfin,hasStremio,stremioHousehold,stremioInstallUrl:links.installUrl,stremioManifestUrl:links.manifestUrl,discordInviteUrl:deliverySettings.discordInviteUrl||'',stremioMetadataAddonUrl:deliverySettings.stremioMetadataAddonUrl||''});
    }catch(error){return next(error);}
  });
  r.post('/account/provisioning/retry',requireCustomer,async(req,res)=>{
    if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));
    try{
      const customerId=req.session.customerId;
      const restored=await cleanupReturn.restoreReturningCustomer(customerId,{reconcile:provisioning.reconcileCustomer});
      if(restored.restored)return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your Jellyfin access has been restored.'));
      const outcome=await provisioning.reconcileCustomer(customerId);
      if(outcome?.active&&outcome?.account?.id)return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your Jellyfin access has been refreshed.'));
      const state=await provisioning.control.getCustomerState(customerId).catch(()=>null),safe=customerProvisioningMessage(state)||'Your Jellyfin access has not completed yet. We will keep retrying automatically.';
      return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));
    }catch(error){
      const safe=customerProvisioningMessage({status:'failed',last_error:error?.message||error})||'Your Jellyfin access has not completed yet. We will keep retrying automatically.';
      return res.redirect('/account?welcome=1&error='+encodeURIComponent(safe));
    }
  });
  return r;
}
module.exports={createCustomerDashboardRouter,hideInternalAccounts,deliveryType,sellablePlans,onboardingMessage,customerProvisioningMessage,stremioDeepLink,stremioLinks,stremioHouseholdForCustomer,libraryProfilesForPortal,discountPreview,returningAccessPage};
