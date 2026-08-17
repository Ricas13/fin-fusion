'use strict';

const core = require('./configuration-transfer-v2-core');
const atomic = require('./configuration-transfer-atomic');
const { query } = require('../db');

const DRIFT_KEY = 'jellyfin_drift_policy';
const RISK_KEY = 'payment_risk_policy';
const SERVER_CLASSES = new Set(['premium','free','custom']);
const LIBRARY_MODES = new Set(['all','include','exclude']);
const PLACEMENT_STRATEGIES = new Set(['least_users','least_streams','weighted']);
const CURRENCIES = new Set(['GBP','USD','EUR']);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function sourceDocument(input) {
    if (input && typeof input === 'object') return input;
    try { return JSON.parse(String(input || '{}')); } catch (_) { return {}; }
}
function int(value,fallback,min,max,{nullable=false}={}) {
    if(nullable&&(value===null||value===undefined||value===''))return null;
    const parsed=Number.parseInt(value,10);
    if(!Number.isFinite(parsed)||parsed<min||parsed>max)return fallback;
    return parsed;
}
function bool(value,fallback=false){return typeof value==='boolean'?value:fallback}
function enumValue(value,allowed,fallback){const clean=String(value||'');return allowed.has(clean)?clean:fallback}
function stringArray(value){return Array.isArray(value)?[...new Set(value.map(item=>String(item||'').trim()).filter(Boolean))].slice(0,500):[]}
function normalizeTierPolicy(source={}) {
    return {
        server_class:enumValue(source.server_class,SERVER_CLASSES,'premium'),
        streams:int(source.streams,1,1,50),
        allow_downloads:bool(source.allow_downloads,false),
        allow_video_transcoding:bool(source.allow_video_transcoding,false),
        allow_audio_transcoding:bool(source.allow_audio_transcoding,true),
        allow_remuxing:bool(source.allow_remuxing,true),
        allow_live_tv:bool(source.allow_live_tv,false),
        allow_live_tv_management:bool(source.allow_live_tv_management,false),
        allow_remote_access:bool(source.allow_remote_access,true),
        allow_4k:bool(source.allow_4k,false),
        library_access_mode:enumValue(source.library_access_mode,LIBRARY_MODES,'all'),
        library_names:stringArray(source.library_names),
        placement_strategy:enumValue(source.placement_strategy,PLACEMENT_STRATEGIES,'least_users'),
        capacity_limit:int(source.capacity_limit,null,0,100000,{nullable:true})
    };
}
function normalizeMapping(mapping={}){
    const provider=String(mapping.provider||'').trim().toLowerCase(),externalId=String(mapping.externalId||mapping.external_id||'').trim().slice(0,200);
    if(!['stripe','paypal'].includes(provider)||!externalId)return null;
    return{provider,externalId,active:mapping.active!==false};
}
function normalizeTierPrices(source={},fallbackTier={}){
    const raw=Array.isArray(source.prices)?source.prices:[];
    const prices=[];
    for(const item of raw.slice(0,3)){
        const currency=String(item?.currency||'').trim().toUpperCase();
        if(!CURRENCIES.has(currency)||prices.some(p=>p.currency===currency))continue;
        const priceMinor=int(item.price_minor??item.priceMinor,null,0,100000000,{nullable:true});
        if(priceMinor===null)continue;
        prices.push({currency,price_minor:priceMinor,active:item.active!==false,is_default:item.is_default===true||item.isDefault===true,providerMappings:(Array.isArray(item.providerMappings)?item.providerMappings:[]).map(normalizeMapping).filter(Boolean).slice(0,2)});
    }
    if(!prices.length){
        const currency=String(fallbackTier.currency||source.currency||'GBP').trim().toUpperCase();
        const priceMinor=int(fallbackTier.monthly_price_minor??source.monthly_price_minor,0,0,100000000);
        prices.push({currency:CURRENCIES.has(currency)?currency:'GBP',price_minor:priceMinor,active:true,is_default:true,providerMappings:(Array.isArray(source.providerMappings)?source.providerMappings:[]).map(normalizeMapping).filter(Boolean).slice(0,2)});
    }
    if(!prices.some(p=>p.is_default)){
        const wanted=String(fallbackTier.currency||source.currency||'').trim().toUpperCase();
        const chosen=prices.find(p=>p.currency===wanted)||prices[0];
        chosen.is_default=true;
    }
    let seenDefault=false;
    for(const price of prices){if(price.is_default&&!seenDefault)seenDefault=true;else price.is_default=false;}
    return prices;
}
function normalizeDriftPolicy(value) {
    const source=object(value),clamp=(input,fallback,min,max)=>{const n=Number.parseInt(input,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
    const normalized={healthyMinutes:clamp(source.healthyMinutes,360,30,1440),driftMinutes:clamp(source.driftMinutes,60,15,720),failureBaseMinutes:clamp(source.failureBaseMinutes,15,5,360),failureMaxMinutes:clamp(source.failureMaxMinutes,360,15,1440),batchSize:clamp(source.batchSize,100,1,1000)};
    if(normalized.failureMaxMinutes<normalized.failureBaseMinutes)normalized.failureMaxMinutes=normalized.failureBaseMinutes;
    return normalized;
}
function normalizeRiskPolicy(value) {
    const source=object(value),pick=(v,allowed,fallback)=>allowed.includes(String(v||''))?String(v):fallback;
    return {
        refundAction: pick(source.refundAction,['preserve','suspend_full_refund'],'preserve'),
        disputeAction: pick(source.disputeAction,['preserve','suspend'],'suspend'),
        chargebackAction: pick(source.chargebackAction,['preserve','suspend'],'suspend'),
        failedRenewalAction: 'provider_state'
    };
}
function hydrateLegacyPlanFields(input) {
    const parsed=sourceDocument(input);
    if(![1,2].includes(Number(parsed?.version))||!object(parsed.configuration))return input;
    const clone=JSON.parse(JSON.stringify(parsed));
    clone.configuration.plans=(Array.isArray(clone.configuration.plans)?clone.configuration.plans:[]).map(plan=>({
        ...plan,
        reseller_credit_cost: Object.prototype.hasOwnProperty.call(plan||{},'reseller_credit_cost') ? plan.reseller_credit_cost : null,
        reseller_trial_credit_cost: Object.prototype.hasOwnProperty.call(plan||{},'reseller_trial_credit_cost') ? plan.reseller_trial_credit_cost : null
    }));
    return clone;
}
function removeRetiredCreditConfiguration(document) {
    if(document?.version!==2||!object(document.configuration))return document;
    for(const plan of document.configuration.plans||[]){delete plan.reseller_credit_cost;delete plan.reseller_trial_credit_cost;}
    if(object(document.configuration.settings)) delete document.configuration.settings.reseller_defaults;
    return document;
}
function parseDocument(input) {
    const source=sourceDocument(input);
    const parsed=core.parseDocument(hydrateLegacyPlanFields(input));if(parsed.version!==2)return parsed;
    const settings=source?.configuration?.settings||{};
    if(settings[DRIFT_KEY]&&typeof settings[DRIFT_KEY]==='object'&&!Array.isArray(settings[DRIFT_KEY]))parsed.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(settings[DRIFT_KEY]);
    if(settings[RISK_KEY]&&typeof settings[RISK_KEY]==='object'&&!Array.isArray(settings[RISK_KEY]))parsed.configuration.settings[RISK_KEY]=normalizeRiskPolicy(settings[RISK_KEY]);
    const sourceTiers=Array.isArray(source?.configuration?.resellerTiers)?source.configuration.resellerTiers:[];
    const sourceByCode=new Map(sourceTiers.map(tier=>[String(tier?.code||'').toLowerCase(),tier]));
    parsed.configuration.resellerTiers=(parsed.configuration.resellerTiers||[]).map(tier=>{
        const original=sourceByCode.get(String(tier.code||'').toLowerCase())||{};
        const prices=normalizeTierPrices(original,tier),defaultPrice=prices.find(p=>p.is_default)||prices[0];
        return{...tier,...normalizeTierPolicy(original),monthly_price_minor:defaultPrice.price_minor,currency:defaultPrice.currency,prices,providerMappings:[]};
    });
    return parsed;
}
async function exportPortableConfiguration() {
    const document=await core.exportPortableConfiguration();if(document.version!==2)return document;
    const [settingsResult,tierPolicies,priceRows]=await Promise.all([
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])`,[[DRIFT_KEY,RISK_KEY]]),
        query(`SELECT id,code,server_class,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names,placement_strategy,capacity_limit FROM reseller_tiers`),
        query(`SELECT pr.tier_id,pr.currency,pr.price_minor,pr.active,pr.is_default,pp.provider,pp.external_id,pp.active mapping_active FROM reseller_tier_prices pr LEFT JOIN reseller_tier_provider_prices pp ON pp.tier_price_id=pr.id AND pp.tier_id=pr.tier_id ORDER BY pr.tier_id,pr.is_default DESC,pr.currency,pp.provider`)
    ]);
    for(const row of settingsResult.rows){if(row.setting_key===DRIFT_KEY)document.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(row.setting_value);if(row.setting_key===RISK_KEY)document.configuration.settings[RISK_KEY]=normalizeRiskPolicy(row.setting_value);}
    const policyByCode=new Map(tierPolicies.rows.map(row=>[String(row.code).toLowerCase(),normalizeTierPolicy(row)]));
    const idByCode=new Map(tierPolicies.rows.map(row=>[String(row.code).toLowerCase(),String(row.id)]));
    const priceByTier=new Map();
    for(const row of priceRows.rows){const key=String(row.tier_id);if(!priceByTier.has(key))priceByTier.set(key,new Map());const byCurrency=priceByTier.get(key),currency=String(row.currency).trim();if(!byCurrency.has(currency))byCurrency.set(currency,{currency,price_minor:Number(row.price_minor),active:Boolean(row.active),is_default:Boolean(row.is_default),providerMappings:[]});if(row.provider)byCurrency.get(currency).providerMappings.push({provider:row.provider,externalId:row.external_id,active:Boolean(row.mapping_active)});}
    document.configuration.resellerTiers=(document.configuration.resellerTiers||[]).map(tier=>{
        const code=String(tier.code||'').toLowerCase(),prices=[...(priceByTier.get(idByCode.get(code))?.values()||[])];
        const normalizedPrices=prices.length?prices:normalizeTierPrices(tier,tier),defaultPrice=normalizedPrices.find(p=>p.is_default)||normalizedPrices[0];
        return{...tier,...(policyByCode.get(code)||normalizeTierPolicy()),monthly_price_minor:defaultPrice.price_minor,currency:defaultPrice.currency,prices:normalizedPrices,providerMappings:[]};
    });
    return removeRetiredCreditConfiguration(document);
}
async function previewImport(input) {
    const document=parseDocument(input),result=await core.previewImport(document),settings=document.configuration.settings;
    const resellerMappings=(document.configuration.resellerTiers||[]).flatMap(t=>(t.prices||[]).flatMap(p=>p.providerMappings||[]));
    const providerMappings=(document.configuration.directPaymentMappings||[]).filter(x=>x.active).length+resellerMappings.filter(x=>x.active).length;
    const warnings=[...(result.warnings||[])];
    if(providerMappings)warnings.push(`${providerMappings} imported payment-provider mapping(s) requested active state. They will be imported inactive and must pass remote verification before sales use them.`);
    if(document.version!==2)return{...result,document,warnings};
    return {...result,document,digest:core.digestDocument(document),warnings:[...new Set(warnings)],summary:{...result.summary,driftPolicy:Object.prototype.hasOwnProperty.call(settings,DRIFT_KEY)?1:0,paymentRiskPolicy:Object.prototype.hasOwnProperty.call(settings,RISK_KEY)?1:0,providerMappingsPendingVerification:providerMappings}};
}
async function applyImport(input,actorUserId=null) {
    const preview=await previewImport(input),document=preview.document;
    const summary=await atomic.applyImport(document,{actorUserId,digest:preview.digest,previewSummary:preview.summary});
    return{digest:preview.digest,warnings:preview.warnings,summary};
}
module.exports={...core,parseDocument,exportPortableConfiguration,previewImport,applyImport,normalizeDriftPolicy,normalizeRiskPolicy,normalizeTierPolicy,normalizeTierPrices};
