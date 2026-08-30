'use strict';

const assert=require('assert');
const http=require('http');

async function main(){
  const dbPath=require.resolve('../src/db');
  const outboundPath=require.resolve('../src/security/outbound-url-policy');
  const registryPath=require.resolve('../src/jellyfin/registry');
  const saved=new Map([dbPath,outboundPath,registryPath].map(key=>[key,require.cache[key]]));
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    let body=null;if(raw){try{body=JSON.parse(raw);}catch{body=raw;}}
    const url=new URL(req.url,'http://127.0.0.1');
    calls.push({method:req.method,path:url.pathname,query:url.searchParams.toString(),token:req.headers['x-emby-token']||null,authorization:req.headers.authorization||null,body});
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'&&url.pathname==='/emby/Users/New')return res.end(JSON.stringify({Id:'emby-user-1',Name:body?.Name||'user'}));
    if(req.method==='POST'&&url.pathname==='/emby/Users/emby-user-1/Password')return res.end('{}');
    if(req.method==='POST'&&url.pathname==='/emby/Users/emby-user-1/Policy')return res.end('{}');
    if(req.method==='GET'&&url.pathname==='/emby/Sessions')return res.end(JSON.stringify([
      {Id:'recent',LastActivityDate:'2026-08-30T07:59:30.000Z',SupportsRemoteControl:true},
      {Id:'stale',LastActivityDate:'2026-08-30T07:40:00.000Z',SupportsRemoteControl:true}
    ]));
    if(req.method==='DELETE'&&url.pathname==='/emby/Users/emby-user-1')return res.end('{}');
    res.statusCode=404;return res.end(JSON.stringify({error:'unexpected route'}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  try{
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{
      query:async(sql,params)=>{
        if(String(sql).includes('FROM jellyfin_servers WHERE id=$1'))return{rowCount:1,rows:[{
          id:params?.[0]||'server-1',name:'Emby Test',slug:'emby-test',server_class:'premium',media_server_type:'emby',
          base_url:`http://127.0.0.1:${address.port}`,public_url:'https://emby.example',enabled:true,priority:100,max_users:100,
          api_key_encrypted:'jf1:runtime-smoke'
        }]};
        throw new Error(`Unexpected DB query in Emby runtime smoke: ${String(sql).slice(0,120)}`);
      }
    }};
    require.cache[outboundPath]={id:outboundPath,filename:outboundPath,loaded:true,exports:{safeFetch:async(url,options)=>fetch(url,options)}};
    const cryptoPath=require.resolve('../src/security/purpose-crypto');
    const originalCrypto=require.cache[cryptoPath];
    const actualCrypto=require(cryptoPath);
    require.cache[cryptoPath]={id:cryptoPath,filename:cryptoPath,loaded:true,exports:{...actualCrypto,decryptWithEnv:()=> 'emby-api-key-runtime-smoke'}};
    delete require.cache[registryPath];
    const registry=require('../src/jellyfin/registry');

    const created=await registry.request('server-1','/Users/New',{method:'POST',body:{Name:'runtime-user',Password:'bootstrap-secret'}});
    assert.strictEqual(created.Id,'emby-user-1');
    assert.deepStrictEqual(calls.slice(0,2).map(call=>`${call.method} ${call.path}`),[
      'POST /emby/Users/New','POST /emby/Users/emby-user-1/Password'
    ],'Emby creation must perform create then password bootstrap through the real registry request path');
    assert.deepStrictEqual(calls[0].body,{Name:'runtime-user'},'Emby create request must not leak the unsupported Password field');
    assert.deepStrictEqual(calls[1].body,{Id:'emby-user-1',NewPw:'bootstrap-secret'},'Emby bootstrap password must use the documented password endpoint body');

    const policy={IsAdministrator:false,EnableRemoteAccess:true,AuthenticationProviderId:'Jellyfin.Server.Auth',PasswordResetProviderId:'Jellyfin.Server.Reset',SyncPlayAccess:'None'};
    await registry.request('server-1','/Users/emby-user-1/Policy',{method:'POST',body:policy});
    const policyCall=calls.find(call=>call.path==='/emby/Users/emby-user-1/Policy');
    assert(policyCall,'Emby policy request was not sent');
    assert.strictEqual(policyCall.body.EnableRemoteAccess,true);
    assert.strictEqual(policyCall.body.AuthenticationProviderId,undefined);
    assert.strictEqual(policyCall.body.PasswordResetProviderId,undefined);
    assert.strictEqual(policyCall.body.SyncPlayAccess,undefined);

    const realNow=Date.now;Date.now=()=>Date.parse('2026-08-30T08:00:00.000Z');
    let sessions;try{sessions=await registry.request('server-1','/Sessions?activeWithinSeconds=120&foo=bar');}finally{Date.now=realNow;}
    const sessionCall=calls.find(call=>call.path==='/emby/Sessions');
    assert(sessionCall,'Emby sessions request was not sent');
    assert.strictEqual(new URLSearchParams(sessionCall.query).has('activeWithinSeconds'),false,'Jellyfin-only session freshness query must not reach Emby');
    assert.strictEqual(new URLSearchParams(sessionCall.query).get('foo'),'bar','unrelated query parameters must survive provider adaptation');
    assert.deepStrictEqual(sessions.map(row=>row.Id),['recent'],'Emby session freshness must be enforced locally');
    assert.strictEqual(sessions[0].SupportsMediaControl,true,'Emby remote-control capability must normalize for the shared stream policy engine');

    await registry.request('server-1','/Users/emby-user-1',{method:'DELETE'});
    assert(calls.some(call=>call.method==='DELETE'&&call.path==='/emby/Users/emby-user-1'),'Emby user deletion must use the provider-prefixed endpoint');
    assert(calls.every(call=>call.token==='emby-api-key-runtime-smoke'),'Every server-to-server Emby request must carry X-Emby-Token');
    assert(calls.every(call=>call.authorization===null),'Emby server-to-server requests must not fall back to the Jellyfin Authorization header');

    console.log('Emby registry mounted HTTP runtime smoke: ok');
    if(originalCrypto)require.cache[cryptoPath]=originalCrypto;else delete require.cache[cryptoPath];
  }finally{
    await new Promise(resolve=>server.close(resolve));
    for(const[key,value]of saved){if(value)require.cache[key]=value;else delete require.cache[key];}
  }
}

main().catch(error=>{console.error(error);process.exit(1);});
