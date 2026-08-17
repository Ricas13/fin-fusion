'use strict';

const Stripe=require('stripe');
const {query}=require('../db');
const providerSettings=require('./provider-settings');
const intents=require('./checkout-intents');
const tierPricing=require('./reseller-tier-pricing');
const monthly=require('../resellers/monthly');

let stripeClient=null,stripeKey=null,paypalToken=null,paypalTokenUntil=0,paypalCredentialKey=null;
function withState(url,intent){const target=new URL(url);target.searchParams.set('checkout_intent',intent.id);target.searchParams.set('checkout_state',intent.nonce);return target.toString()}
async function selectedPrice(tierId,tierPriceId){
  const r=await query(`SELECT pr.*,t.name tier_name,t.seat_limit FROM reseller_tier_prices pr JOIN reseller_tiers t ON t.id=pr.tier_id WHERE pr.id=$1 AND pr.tier_id=$2 AND pr.active=TRUE AND t.active=TRUE AND t.visible=TRUE AND (t.effective_from IS NULL OR t.effective_from<=NOW()) AND (t.effective_until IS NULL OR t.effective_until>NOW()) LIMIT 1`,[tierPriceId,tierId]);
  if(!r.rowCount)throw new Error('The selected reseller price is not currently available.');return r.rows[0];
}
async function contract(tierId,tierPriceId,provider){
  const price=await selectedPrice(tierId,tierPriceId),mapping=await tierPricing.providerMapping(tierId,provider,{tierPriceId,allowFallback:false});
  if(!mapping)throw new Error(`The selected ${String(price.currency).trim()} reseller price is not configured for ${provider==='stripe'?'Stripe':'PayPal'} recurring billing.`);
  return{price,mapping,snapshot:{kind:'reseller_tier',tierId:String(tierId),tierPriceId:String(price.id),priceMinor:Number(price.price_minor),currency:String(price.currency).trim(),tierName:price.tier_name,seatLimit:Number(price.seat_limit),provider,providerMappingId:String(mapping.id)}};
}
async function stripe(){const cfg=await providerSettings.get('stripe'),key=cfg?.restrictedKey||cfg?.apiKey||'';if(!key)throw new Error('Stripe is not configured.');if(!stripeClient||stripeKey!==key){stripeClient=new Stripe(key,{apiVersion:'2026-06-24.dahlia',appInfo:{name:'CAPTAiNFiN Reseller Billing',version:'1.4.0'}});stripeKey=key}return stripeClient}
async function resellerIdentity(resellerId){const r=await query(`SELECT r.id,u.email,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1`,[resellerId]);if(!r.rowCount)throw new Error('Reseller not found.');return r.rows[0]}
async function ensureStripeCustomer(resellerId){const found=await query(`SELECT provider_customer_id FROM reseller_payment_customers WHERE reseller_id=$1 AND provider='stripe'`,[resellerId]);if(found.rowCount)return found.rows[0].provider_customer_id;const identity=await resellerIdentity(resellerId),client=await stripe(),customer=await client.customers.create({email:identity.email||undefined,name:identity.username||undefined,metadata:{billing_scope:'reseller',internal_reseller_id:String(resellerId)}});await query(`INSERT INTO reseller_payment_customers(reseller_id,provider,provider_customer_id) VALUES($1,'stripe',$2) ON CONFLICT(reseller_id,provider) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW()`,[resellerId,customer.id]);return customer.id}
async function createStripeCheckout({resellerId,tierId,tierPriceId,successUrl,cancelUrl}){
  const {price,mapping,snapshot}=await contract(tierId,tierPriceId,'stripe'),intent=await intents.createIntent({scope:'reseller',resellerId,tierId,provider:'stripe',checkoutMode:'subscription',commercialSnapshot:snapshot});
  try{const customer=await ensureStripeCustomer(resellerId),client=await stripe(),metadata={billing_scope:'reseller',internal_reseller_id:String(resellerId),internal_reseller_tier_id:String(tierId),internal_reseller_tier_price_id:String(price.id),internal_checkout_intent_id:String(intent.id)},session=await client.checkout.sessions.create({mode:'subscription',customer,line_items:[{price:mapping.external_id,quantity:1}],success_url:withState(successUrl,intent),cancel_url:cancelUrl,metadata,subscription_data:{metadata}},{idempotencyKey:`reseller-checkout-${intent.id}`});await intents.attachProviderCheckout(intent.id,session.id);return{id:session.id,url:session.url,intentId:intent.id,state:intent.nonce}}
  catch(error){await intents.consume({intentId:intent.id,nonce:intent.nonce,state:'failed'}).catch(()=>{});throw error}
}
function paypalBase(cfg){return cfg?.environment==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com'}
async function paypalAccess(){const cfg=await providerSettings.get('paypal');if(!cfg?.clientId||!cfg?.clientSecret)throw new Error('PayPal is not configured.');const key=`${cfg.environment||'sandbox'}:${cfg.clientId}:${cfg.clientSecret}`;if(key!==paypalCredentialKey){paypalCredentialKey=key;paypalToken=null;paypalTokenUntil=0}if(paypalToken&&Date.now()<paypalTokenUntil-60000)return{cfg,token:paypalToken};const response=await fetch(`${paypalBase(cfg)}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:'grant_type=client_credentials'}),body=await response.json().catch(()=>({}));if(!response.ok||!body.access_token)throw new Error(`PayPal OAuth failed: ${body.error_description||response.status}`);paypalToken=body.access_token;paypalTokenUntil=Date.now()+Number(body.expires_in||300)*1000;return{cfg,token:paypalToken}}
async function paypalApi(path,{method='GET',body=null,requestId=null}={}){const{cfg,token}=await paypalAccess(),response=await fetch(`${paypalBase(cfg)}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(requestId?{'PayPal-Request-Id':requestId}:{})},...(body?{body:JSON.stringify(body)}:{})}),text=await response.text();let payload={};try{payload=text?JSON.parse(text):{}}catch{payload={raw:text}}if(!response.ok)throw new Error(`PayPal HTTP ${response.status}: ${payload.message||payload.name||'request failed'}`);return payload}
async function createPayPalCheckout({resellerId,tierId,tierPriceId,returnUrl,cancelUrl}){
  const {mapping,snapshot}=await contract(tierId,tierPriceId,'paypal'),intent=await intents.createIntent({scope:'reseller',resellerId,tierId,provider:'paypal',checkoutMode:'subscription',commercialSnapshot:snapshot});
  try{const payload=await paypalApi('/v1/billing/subscriptions',{method:'POST',requestId:intent.id,body:{plan_id:mapping.external_id,custom_id:`reseller:${resellerId}:${tierId}`,application_context:{brand_name:process.env.SITE_NAME||'CAPTAiNFiN',shipping_preference:'NO_SHIPPING',user_action:'SUBSCRIBE_NOW',return_url:withState(returnUrl,intent),cancel_url:cancelUrl}}}),url=(payload.links||[]).find(x=>['approve','payer-action'].includes(x.rel))?.href;if(!url)throw new Error('PayPal did not return an approval URL.');await intents.attachProviderCheckout(intent.id,payload.id);return{id:payload.id,url,intentId:intent.id,state:intent.nonce}}
  catch(error){await intents.consume({intentId:intent.id,nonce:intent.nonce,state:'failed'}).catch(()=>{});throw error}
}
async function applyIntentSnapshot(intent,options={}){return monthly.applyCheckoutPriceSnapshot(intent,options)}
async function applyIntentSnapshotById(intentId,options={}){const r=await query(`SELECT * FROM billing_checkout_intents WHERE id=$1`,[intentId]);return applyIntentSnapshot(r.rows[0]||null,options)}
module.exports={selectedPrice,contract,createStripeCheckout,createPayPalCheckout,applyIntentSnapshot,applyIntentSnapshotById};
