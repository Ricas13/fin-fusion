'use strict';

const crypto=require('crypto');
const express=require('express');
const stripe=require('../payments/stripe');
const paypal=require('../payments/paypal');
const plisio=require('../payments/plisio');
const providerSettings=require('../payments/provider-settings');
const jellyfinPlayback=require('../jellyfin/playback-webhook');
const {requestMaintenanceGuard}=require('../security/maintenance-lock');
const STRIPE_RISK=new Set(['charge.refunded','charge.dispute.created','charge.dispute.closed']);
const PAYPAL_RISK=new Set(['PAYMENT.SALE.REFUNDED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.RESOLVED']);
const PLISIO_RISK=new Set();
function sameSecret(actual,expected){const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b)}
function createWebhookRouter(){
 const router=express.Router();
 router.post('/webhooks/stripe',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!stripe.enabled())return res.status(404).end();const signature=req.get('stripe-signature');if(!signature)return res.status(400).send('Missing Stripe signature');await stripe.processWebhook(req.body,signature);return res.json({received:true})}catch(error){console.error('Stripe webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/paypal',express.raw({type:'application/json',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!paypal.enabled())return res.status(404).end();await paypal.processWebhook(req.body,req.headers);return res.json({received:true})}catch(error){console.error('PayPal webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/plisio',express.raw({type:'*/*',limit:'1mb'}),requestMaintenanceGuard,async(req,res)=>{try{await providerSettings.ensureLoaded();if(!plisio.enabled())return res.status(404).end();await plisio.processWebhook(req.body,req.get('content-type')||'');return res.status(200).send('OK')}catch(error){console.error('Plisio webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 router.post('/webhooks/jellyfin/:serverId',express.json({type:'application/json',limit:'256kb'}),requestMaintenanceGuard,async(req,res)=>{try{const secret=String(process.env.JELLYFIN_WEBHOOK_SECRET||'');if(!secret)return res.status(404).end();if(!sameSecret(req.get('x-fin-fusion-webhook-secret'),secret))return res.status(401).send('Webhook rejected');if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(req.params.serverId||'')))return res.status(400).send('Invalid server id');const result=await jellyfinPlayback.ingest(req.params.serverId,req.body||{});return res.json({received:true,...result})}catch(error){console.error('Jellyfin playback webhook error:',error.message);return res.status(400).send('Webhook rejected')}});
 return router;
}
module.exports={createWebhookRouter,STRIPE_RISK,PAYPAL_RISK,PLISIO_RISK,sameSecret};