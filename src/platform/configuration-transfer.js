'use strict';

const core = require('./configuration-transfer-v2-core');
const { query, transaction } = require('../db');

const DRIFT_KEY = 'jellyfin_drift_policy';
const RISK_KEY = 'payment_risk_policy';

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function sourceDocument(input) {
    if (input && typeof input === 'object') return input;
    try { return JSON.parse(String(input || '{}')); } catch (_) { return {}; }
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
function parseDocument(input) {
    const parsed=core.parseDocument(input);if(parsed.version!==2)return parsed;
    const settings=sourceDocument(input)?.configuration?.settings||{};
    if(settings[DRIFT_KEY]&&typeof settings[DRIFT_KEY]==='object'&&!Array.isArray(settings[DRIFT_KEY]))parsed.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(settings[DRIFT_KEY]);
    if(settings[RISK_KEY]&&typeof settings[RISK_KEY]==='object'&&!Array.isArray(settings[RISK_KEY]))parsed.configuration.settings[RISK_KEY]=normalizeRiskPolicy(settings[RISK_KEY]);
    return parsed;
}
async function exportPortableConfiguration() {
    const document=await core.exportPortableConfiguration();if(document.version!==2)return document;
    const result=await query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])`,[[DRIFT_KEY,RISK_KEY]]);
    for(const row of result.rows){
        if(row.setting_key===DRIFT_KEY)document.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(row.setting_value);
        if(row.setting_key===RISK_KEY)document.configuration.settings[RISK_KEY]=normalizeRiskPolicy(row.setting_value);
    }
    return document;
}
async function previewImport(input) {
    const document=parseDocument(input);if(document.version!==2)return core.previewImport(document);
    const result=await core.previewImport(document),settings=document.configuration.settings;
    return {...result,document,digest:core.digestDocument(document),summary:{...result.summary,driftPolicy:Object.prototype.hasOwnProperty.call(settings,DRIFT_KEY)?1:0,paymentRiskPolicy:Object.prototype.hasOwnProperty.call(settings,RISK_KEY)?1:0}};
}
async function applyImport(input,actorUserId=null) {
    const document=parseDocument(input),result=await core.applyImport(document,actorUserId);if(document.version!==2)return result;
    const settings=document.configuration.settings,changes=[];
    if(Object.prototype.hasOwnProperty.call(settings,DRIFT_KEY))changes.push([DRIFT_KEY,normalizeDriftPolicy(settings[DRIFT_KEY]),'admin.configuration.import.drift_policy']);
    if(Object.prototype.hasOwnProperty.call(settings,RISK_KEY))changes.push([RISK_KEY,normalizeRiskPolicy(settings[RISK_KEY]),'admin.configuration.import.payment_risk_policy']);
    if(changes.length)await transaction(async client=>{for(const[key,value,action]of changes){await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[key,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'platform_setting',$3,$4::jsonb)`,[actorUserId,action,key,JSON.stringify(value)]);}});
    return {...result,summary:{...(result.summary||{}),driftPolicy:changes.some(([key])=>key===DRIFT_KEY)?1:0,paymentRiskPolicy:changes.some(([key])=>key===RISK_KEY)?1:0}};
}
module.exports={...core,parseDocument,exportPortableConfiguration,previewImport,applyImport,normalizeDriftPolicy,normalizeRiskPolicy};
