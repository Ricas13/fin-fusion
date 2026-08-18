'use strict';

const core=require('./configuration-transfer-v2-core');
const atomic=require('./configuration-transfer-atomic');
const {query}=require('../db');

const DRIFT_KEY='jellyfin_drift_policy';
const RISK_KEY='payment_risk_policy';
const AFFILIATE_KEY='affiliate_program';

function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function sourceDocument(input){if(input&&typeof input==='object')return input;try{return JSON.parse(String(input||'{}'));}catch(_){return{};}}
function clamp(value,fallback,min,max){const n=Number.parseInt(value,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function normalizeDriftPolicy(value){const source=object(value),normalized={healthyMinutes:clamp(source.healthyMinutes,360,30,1440),driftMinutes:clamp(source.driftMinutes,60,15,720),failureBaseMinutes:clamp(source.failureBaseMinutes,15,5,360),failureMaxMinutes:clamp(source.failureMaxMinutes,360,15,1440),batchSize:clamp(source.batchSize,100,1,1000)};if(normalized.failureMaxMinutes<normalized.failureBaseMinutes)normalized.failureMaxMinutes=normalized.failureBaseMinutes;return normalized;}
function normalizeRiskPolicy(value){const source=object(value),pick=(v,allowed,fallback)=>allowed.includes(String(v||''))?String(v):fallback;return{refundAction:pick(source.refundAction,['preserve','suspend_full_refund'],'preserve'),disputeAction:pick(source.disputeAction,['preserve','suspend'],'suspend'),chargebackAction:pick(source.chargebackAction,['preserve','suspend'],'suspend'),failedRenewalAction:'provider_state'};}
function normalizeAffiliatePolicy(value){const source=object(value);return{enabled:source.enabled===true,rewardPercent:clamp(source.rewardPercent,15,1,100),qualificationDelayDays:clamp(source.qualificationDelayDays,14,0,90),refundWindowDays:clamp(source.refundWindowDays,14,0,90)};}
function hydrateLegacyPlanFields(input){const parsed=sourceDocument(input);if(![1,2].includes(Number(parsed?.version))||!object(parsed.configuration))return input;const clone=JSON.parse(JSON.stringify(parsed));clone.configuration.plans=(Array.isArray(clone.configuration.plans)?clone.configuration.plans:[]).map(plan=>({...plan,reseller_credit_cost:Object.prototype.hasOwnProperty.call(plan||{},'reseller_credit_cost')?plan.reseller_credit_cost:null,reseller_trial_credit_cost:Object.prototype.hasOwnProperty.call(plan||{},'reseller_trial_credit_cost')?plan.reseller_trial_credit_cost:null}));return clone;}

// Only the old reseller credit/wallet contract is retired. Monthly reseller
// plans and their Jellyfin policy/pricing catalogue are live portable config.
function stripRetiredProduct(document){
    if(document?.version!==2||!object(document.configuration))return document;
    for(const plan of document.configuration.plans||[]){
        delete plan.reseller_credit_cost;
        delete plan.reseller_trial_credit_cost;
    }
    if(object(document.configuration.settings))delete document.configuration.settings.reseller_defaults;
    return document;
}

function bool(value,fallback){return typeof value==='boolean'?value:fallback;}
function pick(value,allowed,fallback){const v=String(value||'');return allowed.includes(v)?v:fallback;}
function int(value,fallback,min,max){const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function libraryNames(value){return[...new Set((Array.isArray(value)?value:[]).map(v=>String(v||'').trim().slice(0,200)).filter(Boolean))].slice(0,500);}
function providerMappings(value){
    if(!Array.isArray(value))return[];
    const out=[];
    for(const mapping of value.slice(0,4)){
        const provider=String(mapping?.provider||'').trim().toLowerCase();
        const externalId=String(mapping?.externalId||'').trim().slice(0,200);
        if(!['stripe','paypal'].includes(provider)||!externalId)continue;
        out.push({provider,externalId,active:mapping?.active!==false});
    }
    return out;
}
function tierPrices(value){
    if(!Array.isArray(value))return[];
    const seen=new Set(),out=[];
    for(const price of value.slice(0,10)){
        const currency=String(price?.currency||'').trim().toUpperCase();
        const amount=Number(price?.price_minor);
        if(!/^[A-Z]{3}$/.test(currency)||seen.has(currency)||!Number.isInteger(amount)||amount<0||amount>100000000)continue;
        seen.add(currency);
        out.push({currency,price_minor:amount,active:price?.active!==false,is_default:price?.is_default===true,providerMappings:providerMappings(price?.providerMappings)});
    }
    if(out.length&&!out.some(p=>p.is_default))out[0].is_default=true;
    if(out.filter(p=>p.is_default).length>1){let chosen=false;for(const price of out){if(price.is_default&&!chosen){chosen=true;continue;}price.is_default=false;}}
    return out;
}
function hydrateLiveTierFields(parsed,source){
    if(parsed?.version!==2)return parsed;
    const sourceTiers=Array.isArray(source?.configuration?.resellerTiers)?source.configuration.resellerTiers:[];
    const sourceByCode=new Map(sourceTiers.map(t=>[String(t?.code||'').trim().toLowerCase(),t]));
    parsed.configuration.resellerTiers=(parsed.configuration.resellerTiers||[]).map(tier=>{
        const extra=sourceByCode.get(String(tier.code||'').toLowerCase())||{};
        const prices=tierPrices(extra.prices);
        return{
            ...tier,
            capacity_limit:int(extra.capacity_limit,0,0,1000000),
            server_class:pick(extra.server_class,['premium','free','custom'],'premium'),
            streams:int(extra.streams,1,1,50),
            allow_downloads:bool(extra.allow_downloads,false),
            allow_video_transcoding:bool(extra.allow_video_transcoding,false),
            allow_audio_transcoding:bool(extra.allow_audio_transcoding,true),
            allow_remuxing:bool(extra.allow_remuxing,true),
            allow_live_tv:bool(extra.allow_live_tv,false),
            allow_live_tv_management:bool(extra.allow_live_tv_management,false),
            allow_remote_access:bool(extra.allow_remote_access,true),
            allow_4k:bool(extra.allow_4k,false),
            library_access_mode:pick(extra.library_access_mode,['all','include','exclude'],'all'),
            library_names:libraryNames(extra.library_names),
            placement_strategy:pick(extra.placement_strategy,['least_users','least_streams','weighted'],'least_users'),
            ...(prices.length?{prices}:{})
        };
    });
    return parsed;
}

function parseDocument(input){
    const source=sourceDocument(input);
    const parsed=hydrateLiveTierFields(stripRetiredProduct(core.parseDocument(hydrateLegacyPlanFields(input))),source);
    if(parsed.version!==2)return parsed;
    const settings=source?.configuration?.settings||{};
    if(object(settings[DRIFT_KEY])===settings[DRIFT_KEY])parsed.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(settings[DRIFT_KEY]);
    if(object(settings[RISK_KEY])===settings[RISK_KEY])parsed.configuration.settings[RISK_KEY]=normalizeRiskPolicy(settings[RISK_KEY]);
    if(object(settings[AFFILIATE_KEY])===settings[AFFILIATE_KEY])parsed.configuration.settings[AFFILIATE_KEY]=normalizeAffiliatePolicy(settings[AFFILIATE_KEY]);
    return parsed;
}

async function liveResellerCatalogue(){
    const [tiers,prices,mappings,rules]=await Promise.all([
        query(`SELECT id,code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,capacity_limit,server_class,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names,placement_strategy FROM reseller_tiers ORDER BY sort_order,seat_limit,name`),
        query(`SELECT id,tier_id,currency,price_minor,active,is_default FROM reseller_tier_prices ORDER BY tier_id,is_default DESC,currency`),
        query(`SELECT tier_id,tier_price_id,provider,external_id,active FROM reseller_tier_provider_prices ORDER BY tier_id,tier_price_id,provider`),
        query(`SELECT rr.tier_id,p.code plan_code,rr.active,rr.allow_customer,rr.allow_owner,rr.allow_trial FROM reseller_tier_plan_rules rr JOIN plans p ON p.id=rr.plan_id ORDER BY rr.tier_id,p.code`)
    ]);
    const priceByTier=new Map(),mappingByPrice=new Map(),mappingByTier=new Map(),rulesByTier=new Map();
    for(const row of prices.rows){const key=String(row.tier_id);if(!priceByTier.has(key))priceByTier.set(key,[]);priceByTier.get(key).push(row);}
    for(const row of mappings.rows){
        const tierKey=String(row.tier_id),priceKey=row.tier_price_id?String(row.tier_price_id):'';
        const item={provider:row.provider,externalId:row.external_id,active:row.active};
        if(priceKey){if(!mappingByPrice.has(priceKey))mappingByPrice.set(priceKey,[]);mappingByPrice.get(priceKey).push(item);}
        if(!mappingByTier.has(tierKey))mappingByTier.set(tierKey,[]);mappingByTier.get(tierKey).push(item);
    }
    for(const row of rules.rows){const key=String(row.tier_id);if(!rulesByTier.has(key))rulesByTier.set(key,[]);rulesByTier.get(key).push({planCode:row.plan_code,active:row.active,allowCustomer:row.allow_customer,allowOwner:row.allow_owner,allowTrial:row.allow_trial});}
    return tiers.rows.map(tier=>{
        const tierKey=String(tier.id),tierPriceRows=priceByTier.get(tierKey)||[];
        const normalizedPrices=tierPriceRows.map(price=>({currency:String(price.currency).trim(),price_minor:Number(price.price_minor),active:price.active,is_default:price.is_default,providerMappings:mappingByPrice.get(String(price.id))||[]}));
        const defaultPrice=normalizedPrices.find(p=>p.is_default)||normalizedPrices[0]||null;
        return{
            code:tier.code,name:tier.name,description:tier.description,
            monthly_price_minor:Number(defaultPrice?.price_minor??tier.monthly_price_minor),
            currency:String(defaultPrice?.currency||tier.currency).trim(),
            seat_limit:Number(tier.seat_limit),grace_days:Number(tier.grace_days||0),sort_order:Number(tier.sort_order||0),visible:tier.visible,active:tier.active,
            capacity_limit:Number(tier.capacity_limit||0),server_class:tier.server_class||'premium',streams:Number(tier.streams||1),
            allow_downloads:Boolean(tier.allow_downloads),allow_video_transcoding:Boolean(tier.allow_video_transcoding),allow_audio_transcoding:tier.allow_audio_transcoding!==false,
            allow_remuxing:tier.allow_remuxing!==false,allow_live_tv:Boolean(tier.allow_live_tv),allow_live_tv_management:Boolean(tier.allow_live_tv_management),
            allow_remote_access:tier.allow_remote_access!==false,allow_4k:Boolean(tier.allow_4k),library_access_mode:tier.library_access_mode||'all',library_names:tier.library_names||[],placement_strategy:tier.placement_strategy||'least_users',
            prices:normalizedPrices,
            providerMappings:defaultPrice?.providerMappings||mappingByTier.get(tierKey)||[],
            planRules:rulesByTier.get(tierKey)||[]
        };
    });
}

async function exportPortableConfiguration(){
    const document=stripRetiredProduct(await core.exportPortableConfiguration());
    if(document.version!==2)return document;
    document.configuration.resellerTiers=await liveResellerCatalogue();
    const settingsResult=await query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])`,[[DRIFT_KEY,RISK_KEY,AFFILIATE_KEY]]);
    for(const row of settingsResult.rows){
        if(row.setting_key===DRIFT_KEY)document.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(row.setting_value);
        if(row.setting_key===RISK_KEY)document.configuration.settings[RISK_KEY]=normalizeRiskPolicy(row.setting_value);
        if(row.setting_key===AFFILIATE_KEY)document.configuration.settings[AFFILIATE_KEY]=normalizeAffiliatePolicy(row.setting_value);
    }
    return stripRetiredProduct(document);
}

function requestedProviderMappings(document){
    let count=(document.configuration.directPaymentMappings||[]).filter(x=>x.active).length;
    for(const tier of document.configuration.resellerTiers||[]){
        const prices=Array.isArray(tier.prices)&&tier.prices.length?tier.prices:[{providerMappings:tier.providerMappings||[]}];
        for(const price of prices)count+=(price.providerMappings||[]).filter(x=>x.active).length;
    }
    return count;
}

async function previewImport(input){
    const document=parseDocument(input),result=await core.previewImport(document),settings=document.configuration.settings,providerMappings=requestedProviderMappings(document),warnings=[...(result.warnings||[])];
    if(providerMappings)warnings.push(`${providerMappings} imported payment-provider mapping(s) requested active state. They will be imported inactive and must pass remote verification before sales use them.`);
    if(document.version!==2)return{...result,document,warnings};
    return{...result,document,digest:core.digestDocument(document),warnings:[...new Set(warnings)],summary:{...result.summary,driftPolicy:Object.prototype.hasOwnProperty.call(settings,DRIFT_KEY)?1:0,paymentRiskPolicy:Object.prototype.hasOwnProperty.call(settings,RISK_KEY)?1:0,affiliateProgram:Object.prototype.hasOwnProperty.call(settings,AFFILIATE_KEY)?1:0,providerMappingsPendingVerification:providerMappings}};
}

async function applyImport(input,actorUserId=null){const preview=await previewImport(input),document=preview.document,summary=await atomic.applyImport(document,{actorUserId,digest:preview.digest,previewSummary:preview.summary});return{digest:preview.digest,warnings:preview.warnings,summary};}
module.exports={...core,parseDocument,exportPortableConfiguration,previewImport,applyImport,normalizeDriftPolicy,normalizeRiskPolicy,normalizeAffiliatePolicy,stripRetiredProduct,hydrateLiveTierFields,liveResellerCatalogue};
