'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const resellerBilling=require('../payments/reseller-billing');
const checkoutPricing=require('../payments/reseller-checkout-pricing');
const checkoutIntents=require('../payments/checkout-intents');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function requireCsrf(req,res,next){return csrf.verify(req)?next():res.status(403).send('Invalid security token')}
function redirect(res,key,message,path='/reseller'){return res.redirect(`${path}?${key}=${encodeURIComponent(message)}`)}
function absoluteUrl(req,path){const proto=req.get('x-forwarded-proto')?.split(',')[0]?.trim()||req.protocol,host=req.get('x-forwarded-host')||req.get('host');return `${proto}://${host}${path}`}
async function resolveReseller(userId){const r=await query(`SELECT r.id FROM resellers r WHERE r.user_id=$1`,[userId]);if(!r.rowCount)throw new Error('This account is not linked to a reseller.');return r.rows[0]}
async function activeEntitlement(resellerId){const r=await query(`SELECT 1 FROM reseller_subscriptions WHERE reseller_id=$1 AND status='active' AND current_period_end>NOW() LIMIT 1`,[resellerId]);return r.rowCount>0}

function createResellerMonthlyPortalRouter(){
 const r=express.Router();
 r.use('/reseller/billing',gate,noStore);
 r.use('/reseller/billing',(req,res,next)=>req.method==='POST'?requireCsrf(req,res,next):next());
 r.post('/reseller/billing/stripe',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId);if(await activeEntitlement(reseller.id))throw new Error('A reseller subscription is already active. Use Change plan instead.');const checkout=await checkoutPricing.createStripeCheckout({resellerId:reseller.id,tierId:req.body.tierId,tierPriceId:req.body.tierPriceId,successUrl:absoluteUrl(req,'/reseller?message=Stripe%20checkout%20completed.%20Activation%20will%20follow%20provider%20confirmation.'),cancelUrl:absoluteUrl(req,'/reseller?error=Checkout%20cancelled')});return res.redirect(303,checkout.url)}catch(error){return redirect(res,'error',error.message)}});
 r.post('/reseller/billing/paypal',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId);if(await activeEntitlement(reseller.id))throw new Error('A reseller subscription is already active.');const checkout=await checkoutPricing.createPayPalCheckout({resellerId:reseller.id,tierId:req.body.tierId,tierPriceId:req.body.tierPriceId,returnUrl:absoluteUrl(req,'/reseller/billing/paypal/return'),cancelUrl:absoluteUrl(req,'/reseller?error=PayPal%20checkout%20cancelled')});return res.redirect(303,checkout.url)}catch(error){return redirect(res,'error',error.message)}});
 r.get('/reseller/billing/paypal/return',async(req,res)=>{try{const subscriptionId=String(req.query.subscription_id||'').trim(),intentId=String(req.query.checkout_intent||'').trim(),state=String(req.query.checkout_state||'').trim();if(!subscriptionId||!intentId||!state)throw new Error('PayPal checkout state was incomplete.');const reseller=await resolveReseller(req.session.authUserId),activated=await resellerBilling.activatePayPalCheckout({subscriptionId,intentId,state,resellerId:reseller.id});if(String(activated?.reseller_id||reseller.id)!==String(reseller.id))throw new Error('PayPal checkout belongs to a different reseller.');await checkoutPricing.applyIntentSnapshotById(intentId,{providerSubscriptionId:subscriptionId});return redirect(res,'message','PayPal monthly reseller subscription activated.')}catch(error){return redirect(res,'error',error.message)}});
 r.post('/reseller/billing/checkout/cancel',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId);await checkoutIntents.cancelForOwner('reseller',reseller.id);return redirect(res,'message','Open checkout cleared.')}catch(error){return redirect(res,'error',error.message)}});
 r.post('/reseller/billing/cancel',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId);await resellerBilling.cancelRenewal(reseller.id);return redirect(res,'message','Automatic renewal cancelled. Access remains until the paid-through date.')}catch(error){return redirect(res,'error',error.message)}});
 r.post('/reseller/billing/resume',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId);await resellerBilling.resumeRenewal(reseller.id);return redirect(res,'message','Automatic renewal resumed.')}catch(error){return redirect(res,'error',error.message)}});
 r.post('/reseller/billing/tier',async(req,res)=>{try{const reseller=await resolveReseller(req.session.authUserId),result=await resellerBilling.requestTierChange(reseller.id,req.body.tierId);return redirect(res,'message',result.mode==='period_end'?'Reseller plan change scheduled for the paid-through date.':'Reseller plan changed and verified.')}catch(error){return redirect(res,'error',error.message)}});
 return r;
}

module.exports={createResellerMonthlyPortalRouter,gate,noStore,resolveReseller};
