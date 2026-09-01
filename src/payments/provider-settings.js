'use strict';

const { query } = require('../db');
const { encryptString, decryptString } = require('../crypto');

const PROVIDERS = ['stripe', 'paypal', 'plisio'];
const cache = new Map();
let loaded = false;
let loading = null;

function envConfig(provider) {
    if (provider === 'stripe') {
        const cfg = { source:'environment', restrictedKey:process.env.STRIPE_RESTRICTED_KEY||'', apiKey:process.env.STRIPE_API_KEY||'', webhookSecret:process.env.STRIPE_WEBHOOK_SECRET||'' };
        cfg.enabled = process.env.STRIPE_ENABLED === 'false' ? false : Boolean(cfg.restrictedKey || cfg.apiKey);
        return cfg;
    }
    if (provider === 'plisio') {
        const cfg = { source:'environment', secretKey:process.env.PLISIO_SECRET_KEY||process.env.PLISIO_API_KEY||'' };
        cfg.enabled = process.env.PLISIO_ENABLED === 'false' ? false : Boolean(cfg.secretKey);
        return cfg;
    }
    const cfg = { source:'environment', environment:process.env.PAYPAL_ENV==='live'?'live':'sandbox', clientId:process.env.PAYPAL_CLIENT_ID||'', clientSecret:process.env.PAYPAL_CLIENT_SECRET||'', webhookId:process.env.PAYPAL_WEBHOOK_ID||'' };
    cfg.enabled = process.env.PAYPAL_ENABLED === 'false' ? false : Boolean(cfg.clientId && cfg.clientSecret);
    return cfg;
}

function credentialsConfigured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.restrictedKey || cfg?.apiKey);
    if (provider === 'plisio') return Boolean(cfg?.secretKey);
    return Boolean(cfg?.clientId && cfg?.clientSecret);
}
function configured(provider, cfg) { return Boolean(cfg?.enabled && credentialsConfigured(provider, cfg)); }
function webhookConfigured(provider, cfg) {
    if (provider === 'stripe') return Boolean(cfg?.webhookSecret);
    if (provider === 'plisio') return Boolean(cfg?.secretKey);
    return Boolean(cfg?.webhookId);
}
function checkoutReady(provider,cfg){return Boolean(configured(provider,cfg)&&webhookConfigured(provider,cfg));}
function decodeRow(row) {
    const secrets = JSON.parse(decryptString(row.secrets_encrypted) || '{}'), settings = row.settings || {};
    return { ...secrets, ...settings, enabled:typeof settings.enabled==='boolean'?settings.enabled:credentialsConfigured(row.provider,secrets), source:'database', updatedAt:row.updated_at||null };
}
async function load() {
    if (loading) return loading;
    loading = (async()=>{
        const result=await query('SELECT provider,secrets_encrypted,settings,updated_at FROM payment_provider_credentials WHERE provider=ANY($1::text[])',[PROVIDERS]);
        const rows=new Map(result.rows.map(row=>[row.provider,row]));
        for (const provider of PROVIDERS) cache.set(provider, rows.has(provider)?decodeRow(rows.get(provider)):envConfig(provider));
        loaded=true;
    })().finally(()=>{loading=null;});
    return loading;
}
async function ensureLoaded(){if(!loaded)await load();return true;}
function raw(provider){return cache.get(provider)||envConfig(provider);}
function effective(provider,cfg){
    if(cfg?.enabled!==false)return cfg;
    if(provider==='stripe')return{...cfg,restrictedKey:'',apiKey:'',webhookSecret:''};
    if(provider==='plisio')return{...cfg,secretKey:''};
    return{...cfg,clientId:'',clientSecret:'',webhookId:''};
}
function peek(provider){return effective(provider,raw(provider));}
async function get(provider){if(!PROVIDERS.includes(provider))throw new Error('Unsupported payment provider');await ensureLoaded();return peek(provider);}
async function getRaw(provider){if(!PROVIDERS.includes(provider))throw new Error('Unsupported payment provider');await ensureLoaded();return raw(provider);}
async function status(provider){
    const cfg=await getRaw(provider),credentials=credentialsConfigured(provider,cfg),webhook=webhookConfigured(provider,cfg),ready=checkoutReady(provider,cfg);
    return { provider,source:cfg.source||'environment',enabled:Boolean(cfg.enabled),credentialsConfigured:credentials,configured:configured(provider,cfg),webhookConfigured:webhook,checkoutReady:ready,environment:provider==='paypal'?(cfg.environment==='live'?'live':'sandbox'):null,updatedAt:cfg.updatedAt||null };
}
async function checkoutStatus(){const rows=await Promise.all(PROVIDERS.map(status));return Object.fromEntries(rows.map(row=>[row.provider,row]));}
function clean(value,max=1000){return String(value==null?'':value).trim().slice(0,max);}

async function save(provider,input,actorUserId=null){
    if(!PROVIDERS.includes(provider))throw new Error('Unsupported payment provider');
    const current=await getRaw(provider);let secrets;let settings={enabled:input.enabled!==false};
    if(provider==='stripe'){
        secrets={restrictedKey:input.clearRestrictedKey?'':(clean(input.restrictedKey)||current.restrictedKey||''),apiKey:input.clearApiKey?'':(clean(input.apiKey)||current.apiKey||''),webhookSecret:input.clearWebhookSecret?'':(clean(input.webhookSecret)||current.webhookSecret||'')};
    }else if(provider==='plisio'){
        secrets={secretKey:input.clearSecretKey?'':(clean(input.secretKey,2000)||current.secretKey||'')};
    }else{
        secrets={clientId:input.clearClientId?'':(clean(input.clientId)||current.clientId||''),clientSecret:input.clearClientSecret?'':(clean(input.clientSecret)||current.clientSecret||''),webhookId:input.clearWebhookId?'':(clean(input.webhookId)||current.webhookId||'')};
        settings={...settings,environment:input.environment==='live'?'live':'sandbox'};
    }
    await query(`INSERT INTO payment_provider_credentials(provider,secrets_encrypted,settings,updated_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(provider) DO UPDATE SET secrets_encrypted=EXCLUDED.secrets_encrypted,settings=EXCLUDED.settings,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[provider,encryptString(JSON.stringify(secrets)),JSON.stringify(settings),actorUserId]);
    cache.set(provider,{...secrets,...settings,source:'database',updatedAt:new Date()});loaded=true;return status(provider);
}
async function remove(provider,actorUserId=null){
    if(!PROVIDERS.includes(provider))throw new Error('Unsupported payment provider');
    await query('DELETE FROM payment_provider_credentials WHERE provider=$1',[provider]);cache.set(provider,envConfig(provider));loaded=true;
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.payment_credentials.use_environment','payment_provider',$2,'{}'::jsonb)`,[actorUserId,provider]);
}
async function fetchWithTimeout(url,options,timeoutMs=10000){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{return await fetch(url,{...options,signal:controller.signal,redirect:'error'});}catch(error){if(error?.name==='AbortError')throw new Error('Connection timed out after 10 seconds.');throw error;}finally{clearTimeout(timer);}
}
async function testStripe(cfg){
    const key=cfg.restrictedKey||cfg.apiKey||'';if(!key)throw new Error('Stripe API credentials are not configured.');
    const response=await fetchWithTimeout('https://api.stripe.com/v1/prices?limit=1',{method:'GET',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'}}),body=await response.json().catch(()=>({})),restricted=/^rk_/i.test(key);
    if(response.status===401)throw new Error(body?.error?.message||'Stripe rejected the API key.');
    if(response.status===403){const detail=clean(body?.error?.message,500),suffix='The credential was recognized, but this read probe cannot prove the Customer/Checkout/Coupon write permissions CAPTAiNFiN needs. Check restricted-key permissions and IP restrictions, then complete a test checkout.';return{ok:true,limited:true,message:detail?`Stripe Prices probe was denied (HTTP 403): ${detail} ${suffix}`:`Stripe Prices probe was denied (HTTP 403). ${suffix}`};}
    if(!response.ok)throw new Error(body?.error?.message||`Stripe returned HTTP ${response.status}.`);
    if(restricted)return{ok:true,limited:true,message:'Stripe restricted key authenticated and Prices: Read works. This does not prove the Customer, Checkout Session or Coupon write permissions used by real checkout; complete a test checkout before accepting payments.'};
    return{ok:true,limited:false,message:'Stripe secret key authenticated successfully. Complete a test checkout to verify the full browser and webhook path.'};
}
async function testPayPal(cfg){
    if(!cfg.clientId||!cfg.clientSecret)throw new Error('PayPal client ID and secret are not configured.');
    const host=cfg.environment==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com',basic=Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const response=await fetchWithTimeout(`${host}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${basic}`,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'}),body=await response.json().catch(()=>({}));
    if(!response.ok||!body?.access_token)throw new Error(body?.error_description||body?.message||`PayPal returned HTTP ${response.status}.`);
    return{ok:true,limited:false,message:`PayPal ${cfg.environment==='live'?'Live':'Sandbox'} connection successful. Client credentials were accepted.`};
}
async function testPlisio(cfg){
    if(!cfg.secretKey)throw new Error('Plisio secret key is not configured.');
    const url=new URL('https://api.plisio.net/api/v1/currencies');url.searchParams.set('api_key',cfg.secretKey);
    const response=await fetchWithTimeout(url,{method:'GET',headers:{Accept:'application/json'}}),body=await response.json().catch(()=>({}));
    if(!response.ok||body?.status==='error')throw new Error(body?.data?.message||body?.message||`Plisio returned HTTP ${response.status}.`);
    return{ok:true,limited:false,message:'Plisio connection successful. The merchant secret key was accepted.'};
}
async function testConnection(provider){const cfg=await getRaw(provider);if(provider==='stripe')return testStripe(cfg);if(provider==='paypal')return testPayPal(cfg);if(provider==='plisio')return testPlisio(cfg);throw new Error('Unsupported payment provider');}

module.exports={PROVIDERS,ensureLoaded,get,getRaw,peek,status,checkoutStatus,save,remove,configured,credentialsConfigured,webhookConfigured,checkoutReady,testConnection};
