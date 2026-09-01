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
  capacity_limit:80,stremio_household_network_limit:1,stremio_ip_replacement_policy:'auto_inactive',stremio_ip_replacement_cooldown_minutes:1440,
  discord_role_id:oldRole
};
let savedRole=null;
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
stub('src/platform/admin-request-plan-policy.js',{planCard:()=>'<section id="request-plan"></section>'});
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

    const form=new URLSearchParams({name:'Stremio',description:'Stremio plan',price:'6.00',billingInterval:'month',durationDays:'30',discordRoleId:newRole}).toString();
    const saved=await call(server,'POST',`/admin/plans/${planId}/editor-commerce`,form);
    assert.strictEqual(saved.status,302,'mounted Stremio commerce save should redirect after success');
    assert.strictEqual(savedRole,newRole,'mounted Stremio commerce save must persist plans.discord_role_id');
    assert.deepStrictEqual(queued,{id:planId,actor:actorUserId,params:{discordExtraManagedRoleIds:[oldRole]}},'Stremio role replacement must queue bounded cleanup with the previous managed role');

    const after=await call(server,'GET',`/admin/plans/${planId}/edit`);
    assert.strictEqual(after.status,200);
    assert(after.body.includes(`value="${newRole}" selected`),'saved Stremio Discord role mapping must render selected on the mounted route');
    console.log('mounted Stremio plan Discord role smoke: ok');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
}

main().catch(error=>{console.error(error.stack||error);process.exit(1);});