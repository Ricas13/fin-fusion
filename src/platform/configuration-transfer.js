'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const planCommands=require('../catalog/plan-command-service');
const planContract=require('../catalog/plan-contract');
const notificationPreferenceCommands=require('../integrations/notification-preferences-command-service');
const jobHealth=require('../automation/job-health');
const platformSettingsCommands=require('../configuration/platform-settings-command-service');

const FORMAT='steam-fusion-portable-configuration';
const VERSION=2;
const MAX_DOCUMENT_BYTES=1024*1024;
const LEGACY_V1_MAX_DOCUMENT_BYTES=512*1024;
const EXTRA_SETTINGS=['trial_free_policy','commerce_policy'];
const V1_SETTINGS=new Set(['platform','storefront','storefront_features','admin_defaults','referral_program']);
const V2_SETTINGS=new Set(['trial_free_policy','commerce_policy','jellyfin_drift_policy','payment_risk_policy','affiliate_program']);
const SERVICE_TYPES=new Set(['jellyfin','stremio','bundle']);
const JELLYFIN_ACCESS_MODELS=new Set(['concurrent_streams','household_network']);
const DRIFT_KEY='jellyfin_drift_policy';
const RISK_KEY='payment_risk_policy';
const AFFILIATE_KEY='affiliate_program';
const LEGACY_ENUMS={
    audience:new Set(['direct']),
    billing_interval:new Set(['trial','month','6_months','year','custom']),
    server_class:new Set(['premium','free','custom']),
    library_access_mode:new Set(['all','exclude','include']),
    placement_strategy:new Set(['balanced','lowest_customers','lowest_streams','weighted','manual'])
};

class ConfigurationValidationError extends Error{
    constructor(message,path=''){
        super(message);
        this.name='ConfigurationValidationError';
        this.path=path;
    }
}

function legacyPlainObject(value){return!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function legacyText(value,path,{required=false,max=500,pattern=null}={}){
    if(value==null||value===''){if(required)throw new ConfigurationValidationError('Value is required.',path);return'';}
    if(typeof value!=='string')throw new ConfigurationValidationError('Expected text.',path);
    const clean=value.trim();
    if(required&&!clean)throw new ConfigurationValidationError('Value is required.',path);
    if(clean.length>max)throw new ConfigurationValidationError(`Must be at most ${max} characters.`,path);
    if(pattern&&!pattern.test(clean))throw new ConfigurationValidationError('Value has an invalid format.',path);
    return clean;
}
function legacyBool(value,path){if(typeof value!=='boolean')throw new ConfigurationValidationError('Expected true or false.',path);return value;}
function legacyInteger(value,path,min,max,{nullable=false}={}){
    if((value==null||value==='')&&nullable)return null;
    if(!Number.isInteger(value)||value<min||value>max)throw new ConfigurationValidationError(`Expected an integer between ${min} and ${max}.`,path);
    return value;
}
function legacyEnumValue(value,path,allowed){if(typeof value!=='string'||!allowed.has(value))throw new ConfigurationValidationError(`Unsupported value: ${String(value)}`,path);return value;}
function legacyStringArray(value,path,{maxItems=500,maxLength=200}={}){
    if(!Array.isArray(value))throw new ConfigurationValidationError('Expected a list.',path);
    if(value.length>maxItems)throw new ConfigurationValidationError(`Too many items; maximum is ${maxItems}.`,path);
    const seen=new Set(),output=[];
    for(let i=0;i<value.length;i++){
        const item=legacyText(value[i],`${path}[${i}]`,{required:true,max:maxLength}),key=item.toLowerCase();
        if(!seen.has(key)){seen.add(key);output.push(item);}
    }
    return output;
}
function legacyKeepKeys(source,allowed){const output={};if(!legacyPlainObject(source))return output;for(const key of allowed)if(Object.prototype.hasOwnProperty.call(source,key))output[key]=source[key];return output;}
function legacyNormalizeSetting(key,value){
    if(key==='platform'){
        const src=legacyKeepKeys(value,['siteName','storefrontEnabled','publicRegistration','requireEmailVerification','entitlementJobIntervalMs','serverHealthIntervalMs','overseerrUrl']),out={};
        if('siteName'in src)out.siteName=legacyText(src.siteName,'settings.platform.siteName',{required:true,max:80});
        if('storefrontEnabled'in src)out.storefrontEnabled=legacyBool(src.storefrontEnabled,'settings.platform.storefrontEnabled');
        if('publicRegistration'in src)out.publicRegistration=legacyBool(src.publicRegistration,'settings.platform.publicRegistration');
        if('requireEmailVerification'in src)out.requireEmailVerification=legacyBool(src.requireEmailVerification,'settings.platform.requireEmailVerification');
        if('entitlementJobIntervalMs'in src)out.entitlementJobIntervalMs=legacyInteger(src.entitlementJobIntervalMs,'settings.platform.entitlementJobIntervalMs',30000,10800000);
        if('serverHealthIntervalMs'in src)out.serverHealthIntervalMs=legacyInteger(src.serverHealthIntervalMs,'settings.platform.serverHealthIntervalMs',30000,10800000);
        if('overseerrUrl'in src){
            const url=legacyText(src.overseerrUrl,'settings.platform.overseerrUrl',{max:500});
            if(url){let parsed;try{parsed=new URL(url);}catch(_){throw new ConfigurationValidationError('Expected a valid http/https URL.','settings.platform.overseerrUrl');}if(!['http:','https:'].includes(parsed.protocol))throw new ConfigurationValidationError('Expected an http/https URL.','settings.platform.overseerrUrl');out.overseerrUrl=parsed.href;}else out.overseerrUrl='';
        }
        return out;
    }
    if(key==='storefront'){
        const src=legacyKeepKeys(value,['heroTitle','heroSubtitle','featureTitle','supportEmail','announcement']),out={};
        if('heroTitle'in src)out.heroTitle=legacyText(src.heroTitle,'settings.storefront.heroTitle',{max:140});
        if('heroSubtitle'in src)out.heroSubtitle=legacyText(src.heroSubtitle,'settings.storefront.heroSubtitle',{max:500});
        if('featureTitle'in src)out.featureTitle=legacyText(src.featureTitle,'settings.storefront.featureTitle',{max:140});
        if('supportEmail'in src)out.supportEmail=legacyText(src.supportEmail,'settings.storefront.supportEmail',{max:254});
        if('announcement'in src)out.announcement=legacyText(src.announcement,'settings.storefront.announcement',{max:200});
        return out;
    }
    if(key==='storefront_features')return legacyStringArray(value,'settings.storefront_features',{maxItems:50,maxLength:200});
    if(key==='admin_defaults'){
        const src=legacyKeepKeys(value,['defaultPlanCode','defaultServerClass','defaultServerPriority','defaultServerMaxUsers','expiringWindowDays','recentCustomerLimit']),out={};
        if('defaultPlanCode'in src)out.defaultPlanCode=legacyText(src.defaultPlanCode,'settings.admin_defaults.defaultPlanCode',{max:80});
        if('defaultServerClass'in src)out.defaultServerClass=legacyEnumValue(src.defaultServerClass,'settings.admin_defaults.defaultServerClass',LEGACY_ENUMS.server_class);
        if('defaultServerPriority'in src)out.defaultServerPriority=legacyInteger(src.defaultServerPriority,'settings.admin_defaults.defaultServerPriority',0,10000);
        if('defaultServerMaxUsers'in src)out.defaultServerMaxUsers=legacyInteger(src.defaultServerMaxUsers,'settings.admin_defaults.defaultServerMaxUsers',0,100000);
        if('expiringWindowDays'in src)out.expiringWindowDays=legacyInteger(src.expiringWindowDays,'settings.admin_defaults.expiringWindowDays',1,30);
        if('recentCustomerLimit'in src)out.recentCustomerLimit=legacyInteger(src.recentCustomerLimit,'settings.admin_defaults.recentCustomerLimit',5,50);
        return out;
    }
    if(key==='referral_program'){
        const src=legacyKeepKeys(value,['enabled','rewardDays']),out={};
        if('enabled'in src)out.enabled=legacyBool(src.enabled,'settings.referral_program.enabled');
        if('rewardDays'in src)out.rewardDays=legacyInteger(src.rewardDays,'settings.referral_program.rewardDays',1,365);
        return out;
    }
    throw new ConfigurationValidationError(`Unsupported setting ${key}.`,`settings.${key}`);
}
function legacyNormalizePool(value,path){
    if(!Array.isArray(value))throw new ConfigurationValidationError('Expected a server pool list.',path);
    if(value.length>100)throw new ConfigurationValidationError('Server pool is too large.',path);
    const seen=new Set();
    return value.map((entry,index)=>{
        if(!legacyPlainObject(entry))throw new ConfigurationValidationError('Expected a server pool object.',`${path}[${index}]`);
        const serverSlug=legacyText(entry.serverSlug,`${path}[${index}].serverSlug`,{required:true,max:80,pattern:/^[A-Za-z0-9._-]+$/}),key=serverSlug.toLowerCase();
        if(seen.has(key))throw new ConfigurationValidationError(`Duplicate server slug ${serverSlug}.`,`${path}[${index}].serverSlug`);
        seen.add(key);
        return{serverSlug,weight:legacyInteger(entry.weight==null?100:entry.weight,`${path}[${index}].weight`,1,10000)};
    });
}
function legacyNormalizePlan(source,index){
    const path=`plans[${index}]`;
    if(!legacyPlainObject(source))throw new ConfigurationValidationError('Expected a plan object.',path);
    return{
        code:legacyText(source.code,`${path}.code`,{required:true,max:80,pattern:/^[A-Za-z0-9._-]+$/}),
        name:legacyText(source.name,`${path}.name`,{required:true,max:160}),
        description:legacyText(source.description||'',`${path}.description`,{max:1000}),
        audience:legacyEnumValue(source.audience,`${path}.audience`,LEGACY_ENUMS.audience),
        billing_interval:legacyEnumValue(source.billing_interval,`${path}.billing_interval`,LEGACY_ENUMS.billing_interval),
        duration_days:legacyInteger(source.duration_days,`${path}.duration_days`,1,3650,{nullable:true}),
        price_minor:legacyInteger(source.price_minor,`${path}.price_minor`,0,100000000),
        currency:legacyText(source.currency,`${path}.currency`,{required:true,max:3,pattern:/^[A-Za-z]{3}$/}).toUpperCase(),
        streams:legacyInteger(source.streams,`${path}.streams`,1,50),
        allow_downloads:legacyBool(source.allow_downloads,`${path}.allow_downloads`),
        allow_video_transcoding:legacyBool(source.allow_video_transcoding,`${path}.allow_video_transcoding`),
        allow_audio_transcoding:legacyBool(source.allow_audio_transcoding,`${path}.allow_audio_transcoding`),
        allow_live_tv:legacyBool(source.allow_live_tv,`${path}.allow_live_tv`),
        allow_live_tv_management:legacyBool(source.allow_live_tv_management,`${path}.allow_live_tv_management`),
        allow_4k:legacyBool(source.allow_4k,`${path}.allow_4k`),
        allow_remuxing:legacyBool(source.allow_remuxing,`${path}.allow_remuxing`),
        allow_remote_access:legacyBool(source.allow_remote_access,`${path}.allow_remote_access`),
        server_class:legacyEnumValue(source.server_class,`${path}.server_class`,LEGACY_ENUMS.server_class),
        active:legacyBool(source.active,`${path}.active`),
        visible:legacyBool(source.visible,`${path}.visible`),
        sort_order:legacyInteger(source.sort_order,`${path}.sort_order`,-100000,100000),
        library_access_mode:legacyEnumValue(source.library_access_mode,`${path}.library_access_mode`,LEGACY_ENUMS.library_access_mode),
        library_names:legacyStringArray(source.library_names||[],`${path}.library_names`),
        placement_strategy:legacyEnumValue(source.placement_strategy,`${path}.placement_strategy`,LEGACY_ENUMS.placement_strategy),
        serverPool:legacyNormalizePool(source.serverPool||[],`${path}.serverPool`)
    };
}
function legacyNormalizeNotification(source,index){
    const path=`notifications[${index}]`;
    if(!legacyPlainObject(source))throw new ConfigurationValidationError('Expected a notification object.',path);
    return{event_type:legacyText(source.event_type,`${path}.event_type`,{required:true,max:120,pattern:/^[A-Za-z0-9._-]+$/}),telegram_enabled:legacyBool(source.telegram_enabled,`${path}.telegram_enabled`),email_enabled:legacyBool(source.email_enabled,`${path}.email_enabled`)};
}
function parseV1Document(input){
    const raw=typeof input==='string'?input:JSON.stringify(input);
    if(Buffer.byteLength(raw||'','utf8')>LEGACY_V1_MAX_DOCUMENT_BYTES)throw new ConfigurationValidationError('Configuration document exceeds 512 KiB.');
    let parsed;try{parsed=typeof input==='string'?JSON.parse(input):input;}catch(_){throw new ConfigurationValidationError('Configuration is not valid JSON.');}
    if(!legacyPlainObject(parsed))throw new ConfigurationValidationError('Configuration document must be a JSON object.');
    if(parsed.format!==FORMAT)throw new ConfigurationValidationError(`Unsupported configuration format. Expected ${FORMAT}.`,'format');
    if(parsed.version!==1)throw new ConfigurationValidationError(`Unsupported configuration version ${String(parsed.version)}.`,'version');
    if(!legacyPlainObject(parsed.configuration))throw new ConfigurationValidationError('Missing configuration object.','configuration');
    const settings={},inputSettings=parsed.configuration.settings||{};
    if(!legacyPlainObject(inputSettings))throw new ConfigurationValidationError('Settings must be an object.','settings');
    for(const[key,value]of Object.entries(inputSettings)){if(!V1_SETTINGS.has(key))throw new ConfigurationValidationError(`Unsupported setting ${key}.`,`settings.${key}`);settings[key]=legacyNormalizeSetting(key,value);}
    const inputPlans=parsed.configuration.plans||[];
    if(!Array.isArray(inputPlans)||inputPlans.length>500)throw new ConfigurationValidationError('Plans must be a list of at most 500 items.','plans');
    const plans=inputPlans.map(legacyNormalizePlan),planCodes=new Set();
    for(const plan of plans){const key=plan.code.toLowerCase();if(planCodes.has(key))throw new ConfigurationValidationError(`Duplicate plan code ${plan.code}.`,'plans');planCodes.add(key);}
    const inputNotifications=parsed.configuration.notifications||[];
    if(!Array.isArray(inputNotifications)||inputNotifications.length>500)throw new ConfigurationValidationError('Notifications must be a list of at most 500 items.','notifications');
    const notifications=inputNotifications.map(legacyNormalizeNotification),events=new Set();
    for(const item of notifications){const key=item.event_type.toLowerCase();if(events.has(key))throw new ConfigurationValidationError(`Duplicate notification event ${item.event_type}.`,'notifications');events.add(key);}
    return{format:FORMAT,version:1,configuration:{settings,plans,notifications},excluded:Array.isArray(parsed.excluded)?parsed.excluded.slice(0,50).map(value=>String(value).slice(0,200)):[]};
}
function legacyComparable(value){if(Array.isArray(value))return value.map(legacyComparable);if(legacyPlainObject(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,legacyComparable(value[key])]));return value;}
async function previewV1Import(document){
    const normalized=parseV1Document(document);
    const[existingPlans,serverRows,settingsRows,notificationRows]=await Promise.all([
        query('SELECT code FROM plans'),
        query('SELECT slug FROM jellyfin_servers'),
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key = ANY($1::text[])`,[Object.keys(normalized.configuration.settings)]),
        query('SELECT event_type,telegram_enabled,email_enabled FROM notification_preferences')
    ]);
    const planSet=new Set(existingPlans.rows.map(row=>String(row.code).toLowerCase())),serverSet=new Set(serverRows.rows.map(row=>String(row.slug).toLowerCase())),currentSettings=Object.fromEntries(settingsRows.rows.map(row=>[row.setting_key,row.setting_value])),currentNotifications=new Map(notificationRows.rows.map(row=>[String(row.event_type).toLowerCase(),row])),missingServers=[],poolPlansBlocked=[];
    for(const plan of normalized.configuration.plans){const missing=plan.serverPool.filter(entry=>!serverSet.has(entry.serverSlug.toLowerCase())).map(entry=>entry.serverSlug);if(missing.length){missingServers.push(...missing.map(serverSlug=>({planCode:plan.code,serverSlug})));poolPlansBlocked.push(plan.code);}}
    let settingChanges=0;
    for(const[key,value]of Object.entries(normalized.configuration.settings)){const current=key==='storefront_features'?(Array.isArray(currentSettings[key])?currentSettings[key]:[]):legacyNormalizeSetting(key,currentSettings[key]||{});if(JSON.stringify(legacyComparable(current))!==JSON.stringify(legacyComparable(value)))settingChanges++;}
    let notificationChanges=0;
    for(const item of normalized.configuration.notifications){const current=currentNotifications.get(item.event_type.toLowerCase());if(!current||current.telegram_enabled!==item.telegram_enabled||current.email_enabled!==item.email_enabled)notificationChanges++;}
    return{document:normalized,digest:digestDocument(normalized),summary:{plansCreate:normalized.configuration.plans.filter(plan=>!planSet.has(plan.code.toLowerCase())).length,plansUpdate:normalized.configuration.plans.filter(plan=>planSet.has(plan.code.toLowerCase())).length,settingsChange:settingChanges,notificationsChange:notificationChanges,serverPoolsApply:normalized.configuration.plans.length-new Set(poolPlansBlocked).size,serverPoolsSkipped:new Set(poolPlansBlocked).size},warnings:missingServers.map(item=>`Plan ${item.planCode}: server pool references missing server slug ${item.serverSlug}; that plan's existing pool will be left unchanged.`)};
}

function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function text(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function integer(value,min,max,nullable=true,path=''){if((value===null||value===undefined||value==='')&&nullable)return null;const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new ConfigurationValidationError(`Expected integer between ${min} and ${max}.`,path||undefined);return parsed;}
function enumValue(value,allowed,fallback,path){if(value===null||value===undefined||value==='')return fallback;const normalized=String(value).trim().toLowerCase();if(!allowed.has(normalized))throw new ConfigurationValidationError(`Unsupported value: ${String(value)}`,path);return normalized;}
function boolean(value,fallback,path){if(value===null||value===undefined)return fallback;if(typeof value!=='boolean')throw new ConfigurationValidationError('Expected true or false.',path);return value;}
function digestDocument(document){return crypto.createHash('sha256').update(JSON.stringify(document),'utf8').digest('hex');}
function v1Settings(settings){return Object.fromEntries(Object.entries(settings||{}).filter(([key])=>V1_SETTINGS.has(key)));}
function asV1(document){return{format:FORMAT,version:1,configuration:{settings:v1Settings(document.configuration?.settings),plans:(document.configuration?.plans||[]).map(plan=>({...plan,streams:plan?.streams==null?1:plan.streams})),notifications:document.configuration?.notifications||[]},excluded:document.excluded||[]};}
function quotaFields(source,code){return{request_movie_quota_limit:integer(source.request_movie_quota_limit,0,100000,true,`${code}.request_movie_quota_limit`),request_movie_quota_days:integer(source.request_movie_quota_days,1,3650,true,`${code}.request_movie_quota_days`),request_tv_quota_limit:integer(source.request_tv_quota_limit,0,100000,true,`${code}.request_tv_quota_limit`),request_tv_quota_days:integer(source.request_tv_quota_days,1,3650,true,`${code}.request_tv_quota_days`)}};
function normalizeV2Plan(basePlan,source){
    const code=String(basePlan.code||'plan');
    const hasModularContract=Object.prototype.hasOwnProperty.call(source,'service_type')||Object.prototype.hasOwnProperty.call(source,'jellyfin_access_model');
    if(!hasModularContract)return{...basePlan,streams:Object.prototype.hasOwnProperty.call(source,'streams')?source.streams:basePlan.streams,...quotaFields(source,code),_modular_plan_contract:false};
    const serviceType=enumValue(source.service_type,SERVICE_TYPES,'jellyfin',`${code}.service_type`);
    const jellyfinAccessModel=enumValue(source.jellyfin_access_model,JELLYFIN_ACCESS_MODELS,'concurrent_streams',`${code}.jellyfin_access_model`);
    const hasJellyfin=serviceType==='jellyfin'||serviceType==='bundle',householdJellyfin=hasJellyfin&&jellyfinAccessModel==='household_network';
    const streams=serviceType==='stremio'?1:householdJellyfin?null:integer(source.streams==null?basePlan.streams:source.streams,1,50,false,`${code}.streams`);
    const isAddon=boolean(source.is_addon,false,`${code}.is_addon`);if(isAddon&&serviceType!=='stremio')throw new ConfigurationValidationError('Independent add-ons must be Stremio-only.',`${code}.is_addon`);
    const normalized={...basePlan,service_type:serviceType,capacity_limit:integer(source.capacity_limit,0,1000000,true,`${code}.capacity_limit`)??0,is_addon:isAddon,jellyfin_access_model:hasJellyfin?jellyfinAccessModel:'concurrent_streams',jellyfin_household_network_limit:householdJellyfin?(integer(source.jellyfin_household_network_limit,1,10,true,`${code}.jellyfin_household_network_limit`)??1):1,jellyfin_household_lease_minutes:householdJellyfin?(integer(source.jellyfin_household_lease_minutes,15,1440,true,`${code}.jellyfin_household_lease_minutes`)??240):240,stremio_household_lease_minutes:serviceType==='stremio'||serviceType==='bundle'?(integer(source.stremio_household_lease_minutes,15,1440,true,`${code}.stremio_household_lease_minutes`)??240):240,streams,...quotaFields(source,code),_modular_plan_contract:true};
    try{planContract.validateImportedPlan(normalized);}catch(error){throw new ConfigurationValidationError(error.message,code);}
    return normalized;
}
function normalizeDirectMappings(value){if(!Array.isArray(value))return[];return value.slice(0,1000).map((mapping,index)=>{const provider=text(mapping?.provider,20),checkoutMode=text(mapping?.checkoutMode,20),planCode=text(mapping?.planCode,80),externalId=text(mapping?.externalId,200);if(!planCode)throw new ConfigurationValidationError('Plan code is required.',`directPaymentMappings[${index}].planCode`);try{const validated=planContract.validateProviderMapping({provider,mode:checkoutMode,externalId});return{planCode,provider:validated.provider,checkoutMode:validated.mode,externalId:validated.externalId,active:mapping?.active!==false,metadata:object(mapping?.metadata)}}catch(error){throw new ConfigurationValidationError(error.message,`directPaymentMappings[${index}]`)}});}
function normalizeAutomation(value){if(!Array.isArray(value))return[];return value.slice(0,100).map((job,index)=>({jobKey:text(job?.jobKey,100),enabled:job?.enabled!==false,intervalSeconds:integer(job?.intervalSeconds,30,86400,false,`automation[${index}].intervalSeconds`)})).filter(job=>job.jobKey);}
function parseCoreDocument(input){
    const raw=typeof input==='string'?input:JSON.stringify(input);if(Buffer.byteLength(raw||'','utf8')>MAX_DOCUMENT_BYTES)throw new ConfigurationValidationError('Configuration document exceeds 1 MiB.');
    let parsed;try{parsed=typeof input==='string'?JSON.parse(input):input;}catch(_){throw new ConfigurationValidationError('Configuration is not valid JSON.');}
    if(parsed?.version===1)return parseV1Document(parsed);
    if(!parsed||parsed.format!==FORMAT||parsed.version!==VERSION||!object(parsed.configuration))throw new ConfigurationValidationError(`Expected ${FORMAT} version ${VERSION}.`);
    const base=parseV1Document(asV1(parsed)),inputPlans=Array.isArray(parsed.configuration.plans)?parsed.configuration.plans:[],inputPlanByCode=new Map(inputPlans.map(plan=>[String(plan?.code||'').toLowerCase(),plan]));
    const plans=base.configuration.plans.map(plan=>normalizeV2Plan(plan,inputPlanByCode.get(String(plan.code).toLowerCase())||{}));
    const settings={...base.configuration.settings};for(const key of EXTRA_SETTINGS)if(Object.prototype.hasOwnProperty.call(parsed.configuration.settings||{},key))settings[key]=object(parsed.configuration.settings[key]);
    return{format:FORMAT,version:VERSION,configuration:{settings,plans,notifications:base.configuration.notifications,directPaymentMappings:normalizeDirectMappings(parsed.configuration.directPaymentMappings),automation:normalizeAutomation(parsed.configuration.automation)},excluded:Array.isArray(parsed.excluded)?parsed.excluded.slice(0,100).map(value=>text(value,200)):[]};
}
function sourceDocument(input){if(input&&typeof input==='object')return input;try{return JSON.parse(String(input||'{}'));}catch(_){return{};}}
function clamp(value,fallback,min,max){const n=Number.parseInt(value,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function normalizeDriftPolicy(value){const source=object(value),normalized={healthyMinutes:clamp(source.healthyMinutes,360,30,1440),driftMinutes:clamp(source.driftMinutes,60,15,720),failureBaseMinutes:clamp(source.failureBaseMinutes,15,5,360),failureMaxMinutes:clamp(source.failureMaxMinutes,360,15,1440),batchSize:clamp(source.batchSize,100,1,1000)};if(normalized.failureMaxMinutes<normalized.failureBaseMinutes)normalized.failureMaxMinutes=normalized.failureBaseMinutes;return normalized;}
function normalizeRiskPolicy(value){const source=object(value),pick=(v,allowed,fallback)=>allowed.includes(String(v||''))?String(v):fallback;return{refundAction:pick(source.refundAction,['preserve','suspend_full_refund'],'preserve'),disputeAction:pick(source.disputeAction,['preserve','suspend'],'suspend'),chargebackAction:pick(source.chargebackAction,['preserve','suspend'],'suspend'),failedRenewalAction:'provider_state'};}
function normalizeAffiliatePolicy(value){const source=object(value);return{enabled:source.enabled===true,rewardPercent:clamp(source.rewardPercent,15,1,100),qualificationDelayDays:clamp(source.qualificationDelayDays,14,0,90),refundWindowDays:clamp(source.refundWindowDays,14,0,90)};}
function parseDocument(input){const source=sourceDocument(input),parsed=parseCoreDocument(input);if(parsed.version!==2)return parsed;const settings=source?.configuration?.settings||{};if(object(settings[DRIFT_KEY])===settings[DRIFT_KEY])parsed.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(settings[DRIFT_KEY]);if(object(settings[RISK_KEY])===settings[RISK_KEY])parsed.configuration.settings[RISK_KEY]=normalizeRiskPolicy(settings[RISK_KEY]);if(object(settings[AFFILIATE_KEY])===settings[AFFILIATE_KEY])parsed.configuration.settings[AFFILIATE_KEY]=normalizeAffiliatePolicy(settings[AFFILIATE_KEY]);return parsed;}

async function exportCoreConfiguration(){
    const settingKeys=[...V1_SETTINGS,...EXTRA_SETTINGS];
    const [settingsResult,plansResult,notificationsResult,directMappingsResult,automationResult]=await Promise.all([
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key`,[settingKeys]),
        query(`SELECT p.code,p.name,p.description,p.audience,p.billing_interval,p.duration_days,p.price_minor,p.currency,p.streams,p.allow_downloads,p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,p.allow_live_tv_management,p.allow_4k,p.allow_remuxing,p.allow_remote_access,p.server_class,p.active,p.visible,p.sort_order,p.library_access_mode,p.library_names,p.placement_strategy,p.service_type,p.capacity_limit,p.is_addon,p.jellyfin_access_model,p.jellyfin_household_network_limit,p.jellyfin_household_lease_minutes,p.stremio_household_lease_minutes,p.request_movie_quota_limit,p.request_movie_quota_days,p.request_tv_quota_limit,p.request_tv_quota_days,COALESCE((SELECT jsonb_agg(jsonb_build_object('serverSlug',js.slug,'weight',pse.weight) ORDER BY js.slug) FROM plan_server_eligibility pse JOIN jellyfin_servers js ON js.id=pse.server_id WHERE pse.plan_id=p.id),'[]'::jsonb) AS server_pool FROM plans p ORDER BY p.sort_order,p.price_minor,p.name`),
        query(`SELECT event_type,telegram_enabled,email_enabled FROM notification_preferences ORDER BY event_type`),
        query(`SELECT p.code plan_code,pp.provider,pp.checkout_mode,pp.external_id,pp.active,pp.metadata FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id ORDER BY p.code,pp.provider,pp.checkout_mode`),
        query(`SELECT job_key,enabled,interval_seconds FROM automation_job_state ORDER BY job_key`)
    ]);
    const rawSettings={};for(const row of settingsResult.rows)rawSettings[row.setting_key]=row.setting_value;
    const rawPlans=plansResult.rows.map(row=>({...row,serverPool:row.server_pool||[]}));
    const rawDocument={format:FORMAT,version:VERSION,configuration:{settings:rawSettings,plans:rawPlans,notifications:notificationsResult.rows,directPaymentMappings:directMappingsResult.rows.map(mapping=>({planCode:mapping.plan_code,provider:mapping.provider,checkoutMode:mapping.checkout_mode,externalId:mapping.external_id,active:mapping.active,metadata:mapping.metadata||{}})),automation:automationResult.rows.map(job=>({jobKey:job.job_key,enabled:job.enabled,intervalSeconds:Number(job.interval_seconds)}))},excluded:[]};
    const legacyValidated=parseV1Document(asV1(rawDocument)),legacyByCode=new Map(legacyValidated.configuration.plans.map(plan=>[String(plan.code).toLowerCase(),plan]));
    const plans=rawPlans.map(source=>{const normalized=normalizeV2Plan(legacyByCode.get(String(source.code).toLowerCase()),source);const{_modular_plan_contract,...portable}=normalized;return portable;});
    const settings={...legacyValidated.configuration.settings};for(const key of EXTRA_SETTINGS)if(Object.prototype.hasOwnProperty.call(rawSettings,key))settings[key]=object(rawSettings[key]);
    return{format:FORMAT,version:VERSION,exportedAt:new Date().toISOString(),configuration:{settings,plans,notifications:legacyValidated.configuration.notifications,directPaymentMappings:normalizeDirectMappings(rawDocument.configuration.directPaymentMappings),automation:normalizeAutomation(rawDocument.configuration.automation)},excluded:['payment provider credentials and webhook secrets','Jellyfin URLs/API keys and server identities','customers/subscriptions/payment transactions','sessions/audit/auth history','email/request-service API credentials','branding binary assets']};
}
async function exportPortableConfiguration(){const document=await exportCoreConfiguration();if(document.version!==2)return document;const settingsResult=await query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])`,[[DRIFT_KEY,RISK_KEY,AFFILIATE_KEY]]);for(const row of settingsResult.rows){if(row.setting_key===DRIFT_KEY)document.configuration.settings[DRIFT_KEY]=normalizeDriftPolicy(row.setting_value);if(row.setting_key===RISK_KEY)document.configuration.settings[RISK_KEY]=normalizeRiskPolicy(row.setting_value);if(row.setting_key===AFFILIATE_KEY)document.configuration.settings[AFFILIATE_KEY]=normalizeAffiliatePolicy(row.setting_value);}return document;}
async function previewCoreImport(input){const document=parseCoreDocument(input);if(document.version===1)return previewV1Import(document);const basePreview=await previewV1Import(asV1(document)),existingPlans=await query('SELECT code FROM plans'),planCodes=new Set(existingPlans.rows.map(row=>String(row.code).toLowerCase())),importedPlanCodes=new Set(document.configuration.plans.map(plan=>String(plan.code).toLowerCase())),warnings=[...(basePreview.warnings||[])];for(const mapping of document.configuration.directPaymentMappings)if(!planCodes.has(mapping.planCode.toLowerCase())&&!importedPlanCodes.has(mapping.planCode.toLowerCase()))warnings.push(`Payment mapping skipped unless plan ${mapping.planCode} exists after import.`);return{document,digest:digestDocument(document),warnings:[...new Set(warnings)],summary:{...basePreview.summary,directPaymentMappings:document.configuration.directPaymentMappings.length,automationJobs:document.configuration.automation.length,extendedSettings:EXTRA_SETTINGS.filter(key=>Object.prototype.hasOwnProperty.call(document.configuration.settings,key)).length}};}
function requestedProviderMappings(document){return(document.configuration.directPaymentMappings||[]).filter(x=>x.active).length;}
async function previewImport(input){const document=parseDocument(input),result=await previewCoreImport(document),settings=document.configuration.settings,providerMappings=requestedProviderMappings(document),warnings=[...(result.warnings||[])];if(providerMappings)warnings.push(`${providerMappings} imported payment-provider mapping(s) requested active state. They will be imported inactive and must pass remote verification before sales use them.`);if(document.version!==2)return{...result,document,warnings};return{...result,document,digest:digestDocument(document),warnings:[...new Set(warnings)],summary:{...result.summary,driftPolicy:Object.prototype.hasOwnProperty.call(settings,DRIFT_KEY)?1:0,paymentRiskPolicy:Object.prototype.hasOwnProperty.call(settings,RISK_KEY)?1:0,affiliateProgram:Object.prototype.hasOwnProperty.call(settings,AFFILIATE_KEY)?1:0,providerMappingsPendingVerification:providerMappings}};}

async function applySettings(client,settings,actorUserId){
    return platformSettingsCommands.applyImportedSettings(client,settings,{
        allowedKeys:[...V1_SETTINGS,...V2_SETTINGS],
        actorUserId,
        replaceKeys:['storefront_features']
    });
}

async function applyNotifications(client,items,actorUserId){
    return notificationPreferenceCommands.applyImportedPreferences(client,items,actorUserId);
}

async function applyPlans(client,plans,version=1){
    return planCommands.applyImportedPlans(client,plans,version);
}
async function applyV2Extras(client,configuration){
    const providerResult=await planCommands.applyImportedProviderMappings(client,configuration.directPaymentMappings||[]);
    let automationApplied=0,skippedReferences=providerResult.skippedReferences;
    for(const job of configuration.automation||[]){
        const saved=await jobHealth.applyImportedState(client,job);
        if(saved)automationApplied++;
        else skippedReferences++;
    }
    return{
        ...providerResult,
        automationApplied,
        skippedReferences
    };
}
async function applyAtomicImport(document,{actorUserId=null,digest=null,previewSummary={}}={}){if(!document||!document.configuration)throw new Error('Normalized configuration document is required.');return transaction(async client=>{const settingsApplied=await applySettings(client,document.configuration.settings,actorUserId),notificationsApplied=await applyNotifications(client,document.configuration.notifications,actorUserId),plansResult=await applyPlans(client,document.configuration.plans,document.version),extras=document.version===2?await applyV2Extras(client,document.configuration):{tierMappingsApplied:0,tierPricesApplied:0,tierRulesApplied:0,directMappingsApplied:0,automationApplied:0,skippedReferences:0,mappingsPendingVerification:0};const summary={...previewSummary,settingsApplied,notificationsApplied,...plansResult,...extras,atomic:true,version:document.version};await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.configuration.import.atomic','configuration',$2,$3::jsonb)`,[actorUserId||null,digest||'unknown',JSON.stringify(summary)]);return summary;});}
async function applyImport(input,actorUserId=null){const preview=await previewImport(input),document=preview.document,summary=await applyAtomicImport(document,{actorUserId,digest:preview.digest,previewSummary:preview.summary});return{digest:preview.digest,warnings:preview.warnings,summary};}

module.exports={FORMAT,VERSION,MAX_DOCUMENT_BYTES,ConfigurationValidationError,parseDocument,digestDocument,exportPortableConfiguration,previewImport,applyImport,normalizeV2Plan,normalizeDriftPolicy,normalizeRiskPolicy,normalizeAffiliatePolicy};