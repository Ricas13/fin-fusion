'use strict';

const assert=require('assert');
const http=require('http');
const path=require('path');
const express=require('express');

const root=path.join(__dirname,'..');
const planId='44444444-4444-4444-8444-444444444444';
const oldRole='323456789012345678';
const newRole='423456789012345678';
const actorUserId='55555555-5555-4555-8555-555555555555';
const plan={
  id:planId,code:'stremio',name:'Stremio',description:'Stremio plan',service_type:'stremio',
  price_minor:600,currency:'GBP',billing_interval:'month',duration_days:30,visible:true,active:true,marketing_features:[],
  capacity_limit:80,stremio_household_network_limit:1,stremio_household_lease_minutes:240,
  stremio_ip_replacement_policy:'auto_inactive',stremio_ip_replacement_cooldown_minutes:1440,
  discord_role_id:oldRole
};
let savedRole=null;
let savedLease=null;
let leaseReset=false;
let queued=null;

function modulePath(relative){return require.resolve(path.join(root,relative));}
function stub(relative,exports){const filename=modulePath(relative);require.cache[filename]={id:filename,filename,loaded:true,exports};}
function rows(value=[]){return{rows:value,rowCount:value.length};}

const db={
  async query(sql){
    if(sql.includes('SELECT * FROM plans WHERE id=$1'))return rows([plan]);
    if(sql.includes('SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions'))return rows([{n:1}]);
    throw new Error(`Unexpected Stremio mounted-test query: ${String(sql).replace(/\s+/g,' ').slice(0,180)}`);
  },
  async transaction(fn){
    return fn({query:async(sql,params=[])=>{
      if(sql.includes('UPDATE plans SET name=')){
        savedRole=params[6]||null;
        plan.discord_role_id=savedRole;
        return rows([plan]);
      }
      if(sql.includes('UPDATE subscriptions SET stremio_household_network_limit_snapshot=')){
        assert(sql.includes("stremio_ip_replacement_policy_snapshot='auto_inactive'"),'active Stremio subscriptions must use automatic lease expiry');
        return rows([{id:'subscription-live'}]);
      }
      if(sql.includes('UPDATE access_network_leases SET expires_at=NOW()')){
        leaseReset=true;
        return rows([]);
      }
      if(sql.includes('UPDATE plans SET stremio_household_network_limit=')){
        savedLease=Number(params[2]);
        plan.stremio_household_network_limit=Number(params[1]);
        plan.stremio_household_lease_minutes=savedLease;
        plan.stremio_ip_replacement_policy='auto_inactive';
        return rows([plan]);
      }
      if(sql.includes('INSERT INTO audit_log'))return rows([]);
      throw new Error(`Unexpected Stremio mounted-test transaction query: ${String(sql).replace(/\s+/g,' ').slice(0,180)}`);
    }});
  }
};

stub('src/db.js',db);
stub('src/auth/csrf.js',{token:()=> 'csrf-test',verify:()=>true});
stub('src/security/route-rate-limit.js',{middleware:()=>((_req,_res,next)=>next())});
stub('src/platform/runtime-settings.js',{ensureLoaded:async()=>{},siteName:()=> 'CAPTAiNFiN'});
stub('src/payments/plan-pricing.js',{
  resolvePortalPrice:async()=>({price_minor:600,currency:'GBP'}),
  platformDefaultCurrency:async()=> 'GBP',
  resolvePrice:async()=>({id:'price',price_minor:600,currency:'GBP'}),
  setPrice:async()=>({id:'price'})
});
stub('src/platform/admin-plan-payment-options.js',{mappings:async()=>null,verifyOption:async()=>({}),saveOption:async()=>{}});
stub('src/platform/admin-request-plan-policy.js',{planCard:()=>'<section class="requestPlanCard" id="requests"></section>'});
stub('src/stremio/source-pool.js',{planSources:async()=>[]});
stub('src/access/plan-components.js',{stremioHouseholdConfig:()=>({networkLimit:1})});
stub('src/integrations/discord-roles.js',{
  snowflake:value=>/^\d{15,24}$/.test(String(value||'').trim())?String(value).trim():null,
  roleCatalogue:async()=>({ready:true,roles:[{id:oldRole,name:'Stremio',assignable:true},{id:newRole,name:'Stremio Plus',assignable:true}],assignableRoles:[{id:oldRole,name:'Stremio',assignable:true},{id:newRole,name:'Stremio Plus',assignable:true}]})
});
stub('src/platform/bulk-jobs.js',{
  queuePlanRequestReconciliation:async()=>null,
  queuePlanDiscordReconciliation:async(id,actor,params)=>{queued={id,actor,params};return{id:'job'};}
});
stub('src/platform/admin-html.js',{esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({"&":'&amp;',"<":'&lt;',">":'&gt;',"\"":'&quot;',"'":'&#39;'}[ch])),layout:({body})=>body});

const dispatch=require('../src/platform/admin-stremio-plan-dispatch');

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
  app.use(dispatch.createAdminStremioPlanDispatchRouter());
  app.use((_req,res)=>res.status(404).send('not found'));
  const server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const before=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(before.status,200,'mounted Stremio plan edit route should render');
    assert(before.body.includes('Discord plan role'),'mounted Stremio plan edit route must visibly render Discord plan role');
    assert(before.body.includes(`value="${oldRole}" selected`),'existing Stremio Discord role mapping must be selected');
    assert(before.body.includes('stremioPlanReference'),'Stremio plan editor must opt into the uniform reference grid');
    assert(before.body.includes('id="product"')&&before.body.includes('id="sources"')&&before.body.includes('id="requests"'),'Stremio cards must expose stable plan grid slots without renaming the sources card');
    assert(before.body.includes('name="leaseMinutes"')&&before.body.includes('value="240"'),'connection lease must render its persisted value');
    assert(!before.body.includes('name="replacementPolicy"'),'basic Stremio access must not expose a separate replacement policy');
    assert(!before.body.includes('name="cooldownMinutes"'),'basic Stremio access must not expose a separate replacement cooldown');
    assert.strictEqual((before.body.match(/name="impactConfirmation"/g)||[]).length,1,'a live Stremio plan must render exactly one plan-code confirmation field');
    const impactInput=(before.body.match(/<input[^>]+name="impactConfirmation"[^>]*>/)||[])[0]||'';
    assert(impactInput&&!/\srequired(?:\s|>)/.test(impactInput),'unchanged Stremio access saves must not be blocked by browser-level confirmation');
    assert(before.body.includes('only when Household IPs or connection lease actually changes'),'Stremio confirmation copy must describe only the two editable household controls');

    const accessForm=new URLSearchParams({householdLimit:'1',leaseMinutes:'120',impactConfirmation:'stremio'}).toString();
    const accessSaved=await call(server,'POST',`/admin/plans/${planId}/editor-access`,accessForm);
    assert.strictEqual(accessSaved.status,302,'mounted Stremio access save should redirect after success');
    assert.strictEqual(savedLease,120,'connection lease must persist the submitted number of minutes');
    assert.strictEqual(plan.stremio_ip_replacement_policy,'auto_inactive','saved Stremio access must use the lease as the automatic replacement boundary');
    assert.strictEqual(leaseReset,true,'changing the lease must expire current household leases so the new duration takes effect immediately');

    const leaseReload=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(leaseReload.status,200);
    assert(leaseReload.body.includes('name="leaseMinutes"')&&leaseReload.body.includes('value="120"'),'saved connection lease must survive an editor reload');

    const form=new URLSearchParams({name:'Stremio',description:'Stremio plan',price:'6.00',billingInterval:'month',durationDays:'30',discordRoleId:newRole}).toString();
    const saved=await call(server,'POST',`/admin/plans/${planId}/editor-commerce`,form);
    assert.strictEqual(saved.status,302,'mounted Stremio commerce save should redirect after success');
    assert.strictEqual(savedRole,newRole,'mounted Stremio commerce save must persist plans.discord_role_id');
    assert.deepStrictEqual(queued,{id:planId,actor:actorUserId,params:{discordExtraManagedRoleIds:[oldRole]}},'Stremio role replacement must queue bounded cleanup with the previous managed role');

    const after=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(after.status,200);
    assert(after.body.includes(`value="${newRole}" selected`),'saved Stremio Discord role mapping must render selected on the mounted route');
    console.log('mounted Stremio plan Discord role and lease smoke: ok');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});
