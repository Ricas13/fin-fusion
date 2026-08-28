'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const transfer=require('../src/platform/configuration-transfer');

const root=path.join(__dirname,'..');
function jsFiles(dir){
    const files=[];
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const full=path.join(dir,entry.name);
        if(entry.isDirectory())files.push(...jsFiles(full));
        else if(entry.isFile()&&entry.name.endsWith('.js'))files.push(full);
    }
    return files;
}

assert(!fs.existsSync(path.join(root,'src/platform/configuration-transfer-v1.js')),'legacy transfer codec must remain folded into the canonical owner');
const retiredImporters=jsFiles(path.join(root,'src')).filter(file=>fs.readFileSync(file,'utf8').includes('configuration-transfer-v1')).map(file=>path.relative(root,file).replace(/\\/g,'/'));
assert.deepStrictEqual(retiredImporters,[],'runtime code must not restore the retired configuration-transfer-v1 import path');

function legacyPlan(overrides={}){
    return{
        code:'legacy-monthly',
        name:'Legacy Monthly',
        description:'Legacy portable plan',
        audience:'direct',
        billing_interval:'month',
        duration_days:30,
        price_minor:600,
        currency:'gbp',
        streams:3,
        allow_downloads:true,
        allow_video_transcoding:false,
        allow_audio_transcoding:false,
        allow_live_tv:false,
        allow_live_tv_management:false,
        allow_4k:true,
        allow_remuxing:true,
        allow_remote_access:true,
        server_class:'premium',
        active:true,
        visible:true,
        sort_order:10,
        library_access_mode:'all',
        library_names:[],
        placement_strategy:'balanced',
        serverPool:[{serverSlug:'premium-1',weight:100}],
        ...overrides
    };
}

const document={
    format:transfer.FORMAT,
    version:1,
    configuration:{
        settings:{
            platform:{siteName:' Legacy Portal ',storefrontEnabled:true},
            storefront_features:['Fast','Fast','Simple']
        },
        plans:[legacyPlan()],
        notifications:[{event_type:'payment.completed',telegram_enabled:true,email_enabled:false}]
    },
    excluded:['legacy secret material']
};

const parsed=transfer.parseDocument(JSON.stringify(document));
assert.strictEqual(parsed.version,1,'canonical transfer owner must continue accepting V1 documents');
assert.deepStrictEqual(parsed.configuration.settings.platform,{siteName:'Legacy Portal',storefrontEnabled:true},'V1 settings must retain legacy validation/normalization');
assert.deepStrictEqual(parsed.configuration.settings.storefront_features,['Fast','Simple'],'V1 list normalization must still deduplicate values');
assert.strictEqual(parsed.configuration.plans[0].currency,'GBP','V1 plan currency normalization must be preserved');
assert.deepStrictEqual(parsed.configuration.plans[0].serverPool,[{serverSlug:'premium-1',weight:100}],'V1 server-pool validation must be preserved');
assert.deepStrictEqual(parsed.configuration.notifications[0],{event_type:'payment.completed',telegram_enabled:true,email_enabled:false},'V1 notification normalization must be preserved');

const unsupported=JSON.parse(JSON.stringify(document));
unsupported.configuration.settings.commerce_policy={enabled:true};
assert.throws(
    ()=>transfer.parseDocument(unsupported),
    error=>error instanceof transfer.ConfigurationValidationError&&error.path==='settings.commerce_policy',
    'V1 documents must still reject settings introduced after the V1 schema'
);

const duplicate=JSON.parse(JSON.stringify(document));
duplicate.configuration.plans.push(legacyPlan({code:'LEGACY-MONTHLY',name:'Duplicate'}));
assert.throws(
    ()=>transfer.parseDocument(duplicate),
    error=>error instanceof transfer.ConfigurationValidationError&&error.path==='plans',
    'V1 plan-code uniqueness must remain case-insensitive'
);

console.log('Configuration transfer V1 compatibility through canonical owner passed.');
