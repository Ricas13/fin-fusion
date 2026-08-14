'use strict';
const express=require('express');
const customers=require('../customers');
const lifecycle=require('../payments/lifecycle');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const provisioning=require('../jellyfin/provisioning');
const policy=require('../jellyfin/policy');
const csrf=require('../auth/csrf');
const {createAdminActionsRouter}=require('./admin-actions');
const runtimeSettings=require('./runtime-settings');
function absoluteUrl(req,path){const forwardedProto=req.get('x-forwarded-proto')?.split(',')[0]?.trim();const proto=forwardedProto||req.protocol;const host=req.get('x-forwarded-host')||req.get('host');return `${proto}://${host}${path}`}
function requireCustomer(req,res,next){if(req.session?.customerId&&req.session?.customerUserId)return next();return res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
function safeNext(value){const next=String(value||'');return next.startsWith('/')&&!next.startsWith('//')?next:'/account'}
function createRouter(){const router=express.Router();
  // Store v1 extensions. Existing Activity/Users/Servers/Libraries routes are
  // mounted earlier in platform-preload.js and retain their GET/POST handlers;
  // new business/system pages are served here.
  router.use(createAdminActionsRouter());
  router.get('/account/register',async(req,res)=>{await runtimeSettings.ensureLoaded();return res.render('customer/register',{error:null,registrationOpen:runtimeSettings.publicRegistrationOpen(),referralCode:String(req.query.ref||'').slice(0,20),siteName:process.env.SITE_NAME||'CAPTaINFiN'})});
  router.post('/account/register',async(req,res)=>{try{const created=await customers.registerCustomer({...req.body,referralCode:req.body.referralCode});req.session.customerUserId=created.user.id;req.session.customerId=created.customer.id;req.session.customerUsername=created.user.username;if(runtimeSettings.requireEmailVerification()){const verification=await customers.createAccountToken(created.user.id,'email_verify',24*60);if(process.env.NODE_ENV!=='production')console.log(`Development email verification URL: ${absoluteUrl(req,`/account/verify-email?token=${encodeURIComponent(verification.token)}`)}`);req.session.destroy(()=>{});return res.render('customer/message',{title:'Check your email',message:'Your account has been created and must be verified before you can sign in.',siteName:process.env.SITE_NAME||'CAPTaINFiN'})}return res.redirect('/account')}catch(error){await runtimeSettings.ensureLoaded();return res.status(400).render('customer/register',{error:error.message,registrationOpen:runtimeSettings.publicRegistrationOpen(),referralCode:String(req.body.referralCode||'').slice(0,20),siteName:process.env.SITE_NAME||'CAPTaINFiN'})}});
  router.get('/account/verify-email',async(req,res)=>{const ok=await customers.verifyEmail(req.query.token);return res.status(ok?200:400).render('customer/message',{title:ok?'Email verified':'Verification failed',message:ok?'Your email is verified. You can now sign in.':'This verification link is invalid or has expired.',siteName:process.env.SITE_NAME||'CAPTaINFiN'})});
  router.get('/account/login',(req,res)=>res.render('customer/login',{error:null,next:safeNext(req.query.next),siteName:process.env.SITE_NAME||'CAPTaINFiN'}));
  router.post('/account/login',async(req,res)=>{try{const account=await customers.authenticateCustomer(req.body.identity,req.body.password);if(!account)throw new Error('Invalid email/username or password');req.session.customerUserId=account.userId;req.session.customerId=account.customerId;req.session.customerUsername=account.username;return res.redirect(safeNext(req.body.next))}catch(error){return res.status(401).render('customer/login',{error:error.message,next:safeNext(req.body.next),siteName:process.env.SITE_NAME||'CAPTaINFiN'})}});
  router.post('/account/logout',requireCustomer,(req,res)=>req.session.destroy(()=>res.redirect('/account/login')));
  router.get('/account',requireCustomer,async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const portal=await customers.getCustomerPortal(req.session.customerId);const plans=await customers.listPublicPlans();const currentPlan=await provisioning.currentEntitlement(req.session.customerId);const effective=currentPlan?await provisioning.effectivePolicyForCustomer(req.session.customerId,currentPlan):null;const libraryEntitlement=effective?effective.entitlementRows.filter(r=>r.effective).map(r=>r.name):[];const librarySelection=effective?effective.visibleNames:[];return res.render('customer/dashboard',{portal,plans,currentPlan,stripeEnabled:stripe.enabled(),paypalEnabled:paypal.enabled(),overseerrUrl:runtimeSettings.overseerrUrl(),libraryEntitlement,librarySelection,csrfToken:csrf.token(req),siteName:process.env.SITE_NAME||'CAPTaINFiN',message:req.query.message||null,error:req.query.error||null})}catch(error){return next(error)}});
  router.post('/account/libraries',requireCustomer,async(req,res)=>{
    if(!csrf.verify(req))return res.redirect('/account?error='+encodeURIComponent('Invalid or expired security token'));
    try{
        const plan=await provisioning.currentEntitlement(req.session.customerId);
        const effective=await provisioning.effectivePolicyForCustomer(req.session.customerId,plan);
        const submitted=Array.isArray(req.body.library)?req.body.library:(req.body.library!==undefined?[req.body.library]:[]);
        const chosen=[];
        for(const raw of submitted){
            const name=String(raw||'').trim();
            if(!name)continue;
            // The backend re-derives entitlement itself and only accepts names
            // that are BOTH in the discovered catalog AND currently entitled --
            // a submitted name outside that (however it was crafted) is dropped,
            // never granted.
            const match=effective.entitlementRows.find(r=>r.effective&&policy.nameKey(r.name)===policy.nameKey(name));
            if(match)chosen.push(match.name);
        }
        await provisioning.setLibrarySelection(req.session.customerId,chosen);
        try{await provisioning.reconcileCustomer(req.session.customerId)}catch(_){}
        return res.redirect('/account?message='+encodeURIComponent('Library visibility updated.'));
    }catch(error){
        return res.redirect('/account?error='+encodeURIComponent('Library visibility could not be updated safely.'));
    }
  });
  router.post('/account/trial/start',requireCustomer,async(req,res)=>{try{await lifecycle.startFreeTrial(req.session.customerId);return res.redirect('/account?message='+encodeURIComponent('Your 24-hour trial is active.'))}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.post('/account/claim-free/:planCode',requireCustomer,async(req,res)=>{try{await lifecycle.claimFreePlan(req.session.customerId,req.params.planCode);return res.redirect('/account?message='+encodeURIComponent('Free access is active.'))}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.post('/account/checkout/stripe',requireCustomer,async(req,res)=>{try{const portal=await customers.getCustomerPortal(req.session.customerId);const checkout=await stripe.createCheckout({customerId:req.session.customerId,planCode:req.body.planCode,email:portal?.customer?.login_email||portal?.customer?.email,discountCode:req.body.discountCode||null,successUrl:absoluteUrl(req,'/account?message=Payment%20received'),cancelUrl:absoluteUrl(req,'/account?error=Checkout%20cancelled')});return res.redirect(303,checkout.url)}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.post('/account/stripe/portal',requireCustomer,async(req,res)=>{try{const portal=await stripe.createCustomerPortal({customerId:req.session.customerId,returnUrl:absoluteUrl(req,'/account')});return res.redirect(303,portal.url)}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.post('/account/checkout/paypal',requireCustomer,async(req,res)=>{try{const checkout=await paypal.createCheckout({customerId:req.session.customerId,planCode:req.body.planCode,discountCode:req.body.discountCode||null,returnUrl:absoluteUrl(req,'/account/paypal/return'),cancelUrl:absoluteUrl(req,'/account?error=PayPal%20checkout%20cancelled')});req.session.pendingPayPal={id:checkout.id,mode:checkout.mode};return res.redirect(303,checkout.url)}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.get('/account/paypal/return',requireCustomer,async(req,res)=>{try{const pending=req.session.pendingPayPal||{};if(pending.mode==='payment'){const orderId=req.query.token||pending.id;if(!orderId||orderId!==pending.id)throw new Error('PayPal order does not match this session');await paypal.captureOrder(orderId)}else{const subscriptionId=req.query.subscription_id||pending.id;if(!subscriptionId||subscriptionId!==pending.id)throw new Error('PayPal subscription does not match this session');await paypal.activateSubscription(subscriptionId)}delete req.session.pendingPayPal;return res.redirect('/account?message='+encodeURIComponent('PayPal payment completed.'))}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.post('/account/jellyfin/:accountId/password',requireCustomer,async(req,res)=>{try{await provisioning.setJellyfinPassword(req.session.customerId,req.params.accountId,req.body.password);return res.redirect('/account?message='+encodeURIComponent('Jellyfin password updated.'))}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message))}});
  router.get('/api/platform/plans',async(_req,res,next)=>{try{return res.json(await customers.listPublicPlans())}catch(error){return next(error)}});
  router.use((error,req,res,_next)=>{console.error('Platform route error:',error);if(req.path.startsWith('/api/'))return res.status(500).json({success:false,error:'Internal server error'});return res.status(500).render('customer/message',{title:'Something went wrong',message:'The request could not be completed. Please try again.',siteName:process.env.SITE_NAME||'CAPTaINFiN'})});
  return router}
module.exports={createRouter,requireCustomer};
