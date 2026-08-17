'use strict';

const core = require('./configuration-transfer-v2-core');
const atomic = require('./configuration-transfer-atomic');
const { query } = require('../db');

const DRIFT_KEY = 'jellyfin_drift_policy';
const RISK_KEY = 'payment_risk_policy';
const SERVER_CLASSES = new Set(['premium','free','custom']);
const LIBRARY_MODES = new Set(['all','include','exclude']);
const PLACEMENT_STRATEGIES = new Set(['least_users','least_streams','weighted']);

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
    if(parsed?.version!==2||!object(parsed.configuration))return input;
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
    for(const plan of document.configuration.plans||[]){
        delete plan.reseller_credit_cost;
        delete plan.reseller_trial_credit_cost;
    }
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
    parsed.configuration.resellerTiers=(parsed.configuration.resellerTiers||[]).map(tier=>({
        ...tier,
        ...normalizeTierPolicy(sourceByCode.get(String(tier.code||'').toLowerCase())||{})
    }));
    return parsed;
}
async function exportPortableConfiguration() {
    const document=await core.exportPortableConfiguration();if(document.version!==2)return document;
    const [settingsResult,tierPolicies]=await Promise.all([
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])`,[[DRIFT_KEY,RISK_KEY]]),
        query(`SELECT code,server_class,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,library_access_mode,library_names,placement_strategy,capacity_limit FROM reseller_tiers`)
    ]);
    for(const row of settingsResult.rows){
        if(row.setting_key===DRIFT_KEY)document.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(row.setting_value);
        if(row.setting_key===RISK_KEY)document.configuration.settings[RISK_KEY]=normalizeRiskPolicy(row.setting_value);
    }
    const policyByCode=new Map(tierPolicies.rows.map(row=>[String(row.code).toLowerCase(),normalizeTierPolicy(row)]));
    document.configuration.resellerTiers=(document.configuration.resellerTiers||[]).map(tier=>({
        ...tier,
        ...(policyByCode.get(String(tier.code||'').toLowerCase())||normalizeTierPolicy())
    }));
    return removeRetiredCreditConfiguration(document);
}
async function previewImport(input) {
    const document=parseDocument(input);const result=await core.previewImport(document),settings=document.configuration.settings;
    const providerMappings=(document.configuration.directPaymentMappings||[]).filter(x=>x.active).length+(document.configuration.resellerTiers||[]).flatMap(t=>t.providerMappings||[]).filter(x=>x.active).length;
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
module.exports={...core,parseDocument,exportPortableConfiguration,previewImport,applyImport,normalizeDriftPolicy,normalizeRiskPolicy,normalizeTierPolicy};
