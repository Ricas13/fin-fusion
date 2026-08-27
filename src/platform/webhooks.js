'use strict';

const express=require('express');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const plisio=require('../payments/plisio');
const providerSettings=require('../payments/provider-settings');
const checkoutIntents=require('../payments/checkout-intents');
const incidents=require('../payments/incidents');
const {requestMaintenanceGuard}=require('../security/maintenance-lock');
function parse(raw){try{return JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw||'{}'))}catch{return{}}}
const STRIPE_RISK=new Set(['charge.refunded','charge.dispute.created','charge.dispute.closed']);
const PAYPAL_RISK=new Set(['PAYMENT.SALE.REFUNDED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.RESOLVED']);
const PLISIO_RISK=new Set();
function paypalCheckoutCompletion(event){const resource=event?.resource||{};if(event?.event_type==='BILLING.SUBSCRIPTION.ACTIVATED')return resource.id||null;if(event?.event_type==='PAYMENT.SALE.COMPLETED')return resource.billing_agreement_id||null;return null}
function intentIdentity(intent){if(!intent||intent.scope!=='customer')return{scope:'unresolved',customerId:null};return{scope:'direct',customerId:intent.customer_id}}
async function completeCheckoutOrIncident({provider,eventId,eventType,providerId,state='completed',providerSubscriptionId=null}){try{const completed=await checkoutIntents.completeVerifiedProvider(provider,providerId,state);if(state==='completed'&&!completed)throw new Error('Provider confirmed checkout but no matching local checkout intent exists.');return completed}catch(error){if(state==='completed'){const intent=await checkoutIntents.findProviderIntent(provider,providerId).catch(()=>null);await incidents.record({provider,eventId:String(eventId||providerId),caseId:providerId,kind:'checkout_completion',status:'open',identity:intentIdentity(intent),metadata:{eventType,checkoutIntentId:intent?.id||null,checkoutState:intent?.state||null,error:String(error.message||error).slice(0,1000)}}).catch(recordError=>console.error('Checkout completion incident could not be recorded:',recordError.message));}throw error}}
function createWebhookRouter(){
 const router=express.Router();
 router.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!stripe.enabled())return res.status(404).end();const signature=req.get('stripe-signature');if(!signature)return res.status(400).send('Missing Stripe signature');await stripe.processWebhook(req.body,signature);return res.json({received:true})}catch(error){console.error('Stripe webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/paypal',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!paypal.enabled())return res.status(404).end();const event=parse(req.body);await paypal.processWebhook(req.body,req.headers);const providerId=paypalCheckoutCompletion(event);if(providerId)await completeCheckoutOrIncident({provider:'paypal',eventId:event.id,eventType:event.event_type,providerId,state:'completed',providerSubscriptionId:providerId});return res.json({received:true})}catch(error){console.error('PayPal webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/plisio',express.raw({type:'*/*',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!plisio.enabled())return res.status(404).end();await plisio.processWebhook(req.body,req.get('content-type')||'');return res.status(200).send('OK')}catch(error){console.error('Plisio webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 return router;
}
module.exports={createWebhookRouter,STRIPE_RISK,PAYPAL_RISK,PLISIO_RISK,paypalCheckoutCompletion,completeCheckoutOrIncident,intentIdentity};
