'use strict';

const assert=require('assert');
const http=require('http');
const path=require('path');
const express=require('express');

const root=path.join(__dirname,'..');
const planId='11111111-1111-4111-8111-111111111111';
const oldRole='123456789012345678';
const newRole='223456789012345678';
const actorUserId='33333333-3333-4333-8333-333333333333';
const plan={
  id:planId,code:'free_server',name:'Free Server',description:'Free plan',service_type:'jellyfin',is_free_tier:true,
  price_minor:0,billing_interval:'month',duration_days:30,server_class:'free',visible:true,active:true,marketing_features:[],
  capacity_limit:80,placement_strategy:'balanced',library_access_mode:'all',library_names:[],inactivity_policy:{},discord_role_id:oldRole
};
let savedRole=null;
let queued=null;

function modulePath(relative){return require.resolve(path.join(root,relative));}
function stub(relative,exports){const filename=modulePath(relative);require.cache[filename]={id:filename,filename,loaded:true,exports};}
function rows(value=[]){return{rows:value,rowCount:value.length};}

const db={
  async query(sql){
    if(sql.includes('SELECT * FROM plans WHERE id=$1'))return rows([plan]);
    if(sql.includes('FROM jellyfin_servers'))return rows([]);
    throw new Error(`Unexpected mounted-test query: ${String(sql).replace(/\s+/g,' ').slice(0,160)}`);
  },
  async transaction(fn){
    return fn({query:async(sql,params=[])=>{
      if(sql.includes('UPDATE plans SET name=')){
        savedRole=params[6]||null;
        plan.discord_role_id=savedRole;
        return rows([plan]);
      }
      if(sql.includes('INSERT INTO audit_log'))return rows([]);
      throw new Error(`Unexpected mounted-test transaction query: ${String(sql).replace(/\s+/g,' ').slice(0,160)}`);
    }});
  }
};
stub('src/db.js',db);
stub('src/auth/csrf.js',{token:()=> 'csrf-test',verify:()=>true});
stub('src/security/route-rate-limit.js',{middleware:()=>((_req,_res,next)=>next())});
stub('src/platform/runtime-settings.js',{ensureLoaded:async()=>{},siteName:()=> 'CAPTAiNFiN'});
stub('src/entitlements/plan-capacity.js',{usage:async()=>({used:1,reserved:0,limit:80,remaining:79})});
stub('src/platform/admin-plan-access.js',{
  subscriberCount:async()=>1,
  values:()=>({accessModel:'concurrent_streams',streams:1,jellyfinHouseholdNetworkLimit:1,jellyfinHouseholdLeaseMinutes:60,allowDownloads:false,allowVideoTranscoding:true,allowAudioTranscoding:true,allowRemuxing:true,allowLiveTv:false,allowLiveTvManagement:false,allowRemoteAccess:true,allow4k:true,allowSubtitleEditing:false}),
  parse:()=>({}),save:async()=>{}
});
stub('src/platform/admin-plan-libraries.js',{discoverLibraries:async()=>({servers:[],catalog:[],failed:[]})});
stub('src/payments/plan-pricing.js',{platformDefaultCurrency:async()=> 'GBP',resolvePrice:async()=>null,setPrice:async()=>({id:'price'})});
stub('src/platform/admin-plan-payment-options.js',{mappings:async()=>null,verifyOption:async()=>({}),saveOption:async()=>{}});
stub('src/platform/admin-request-plan-policy.js',{planCard:()=>'<section id="request-plan"></section>'});
stub('src/jellyfin/placement.js',{normalizeStrategy:value=>value||'balanced'});
stub('src/integrations/discord-roles.js',{
  snowflake:value=>/^\d{15,24}$/.test(String(value||'').trim())?String(value).trim():null,
  roleCatalogue:async()=>({ready:true,roles:[{id:oldRole,name:'Free Server',assignable:true},{id:newRole,name:'Premium',assignable:true}],assignableRoles:[{id:oldRole,name:'Free Server',assignable:true},{id:newRole,name:'Premium',assignable:true}]})
});
stub('src/platform/bulk-jobs.js',{
  queuePlanReconciliation:async()=>null,
  queuePlanDiscordReconciliation:async(id,actor,params)=>{queued={id,actor,params};return{id:'job'};}
});
stub('src/platform/admin-html.js',{esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({"&":'&amp;',"<":'&lt;',">":'&gt;',"\"":'&quot;',"'":'&#39;'}[ch])),layout:({body})=>body});
stub('src/entitlements/plan-lifecycle-policy.js',{effectiveForFreePlan:()=>({enabled:false,dryRun:true,noPlaybackDays:null,minimumPlaybackMinutes:null,playbackWindowDays:7,minimumObservationHours:48,deleteAfterDisableDays:1,inherited:{}}),save:async()=>{}});
stub('src/entitlements/jellyfin-lifecycle-policy.js',{get:async()=>({freeNoPlaybackDays:7}),categoryFor:()=> 'free',deleteDays:()=>({days:1})});
stub('src/platform/admin-checkbox-form.js',{explicitCheckboxes:body=>body});

const editor=require('../src/platform/admin-jellyfin-plan-editor');

function call(server,method,url,body=''){
  const port=server.address().port;
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method,path:url,headers:body?{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body)}:{}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:text}));
    });
    req.on('error',reject);if(body)req.write(body);req.end();
  });
}

async function main(){
  const app=express();
  app.use(express.urlencoded({extended:false}));
  app.use((req,_res,next)=>{req.session={authUserId:actorUserId,authRole:'admin',adminId:'admin-test'};next();});
  app.use(editor.createAdminJellyfinPlanEditorRouter());
  app.use((_req,res)=>res.status(404).send('not found'));
  const server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const before=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(before.status,200,'mounted plan edit route should render');
    assert(before.body.includes('Discord plan role'),'mounted plan edit route must visibly render Discord plan role');
    assert(before.body.includes(`value="${oldRole}" selected`),'existing Discord role mapping must be selected');

    const form=new URLSearchParams({name:'Free Server',description:'Free plan',discordRoleId:newRole,impactConfirmation:'free_server'}).toString();
    const saved=await call(server,'POST',`/admin/plans/${planId}/editor-product`,form);
    assert.strictEqual(saved.status,302,'mounted product save should redirect after success');
    assert.strictEqual(savedRole,newRole,'mounted product save must persist plans.discord_role_id');
    assert.deepStrictEqual(queued,{id:planId,actor:actorUserId,params:{discordExtraManagedRoleIds:[oldRole]}},'role replacement must queue bounded cleanup with the previous managed role');

    const after=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(after.status,200);
    assert(after.body.includes(`value="${newRole}" selected`),'saved Discord role mapping must render selected on the mounted route');
    console.log('mounted plan Discord role smoke: ok');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});