'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
process.env.JELLYFIN_ENCRYPTION_KEY='42'.repeat(32);
const outbound=require('../src/security/outbound-url-policy');
const client=require('../src/stremio/source-client');

(async()=>{
  const original=outbound.safeFetch;
  const calls=[];
  try{
    outbound.safeFetch=async(url,options={})=>{
      calls.push({url:String(url),options});
      const pathname=new URL(String(url)).pathname;
      if(pathname==='/jellyfin/Users/AuthenticateByName')return new Response(JSON.stringify({AccessToken:'normal-user-access-token-123456789',User:{Id:'user-123',Name:'source-user'}}),{status:200,headers:{'content-type':'application/json'}});
      if(pathname==='/jellyfin/Users/user-123/Views')return new Response(JSON.stringify({Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'},{Id:'shows',Name:'TV',CollectionType:'tvshows'},{Id:'music',Name:'Music',CollectionType:'music'}]}),{status:200,headers:{'content-type':'application/json'}});
      if(pathname==='/jellyfin/Sessions/Logout')return new Response(null,{status:204});
      if(pathname==='/media/Users/AuthenticateByName')return new Response(null,{status:404});
      if(pathname==='/media/emby/Users/AuthenticateByName')return new Response(JSON.stringify({AccessToken:'emby-user-access-token-123456789',User:{Id:'emby-user-1',Name:'emby-source'}}),{status:200,headers:{'content-type':'application/json'}});
      if(pathname==='/media/emby/Users/emby-user-1/Views')return new Response(JSON.stringify({Items:[{Id:'emovies',Name:'Movies',CollectionType:'movies'}]}),{status:200,headers:{'content-type':'application/json'}});
      if(pathname==='/media/emby/Sessions/Logout')return new Response(null,{status:204});
      if(pathname==='/emby/Users/AuthenticateByName')return new Response(JSON.stringify({AccessToken:'emby-root-token-123456789',User:{Id:'emby-root-user',Name:'emby-root'}}),{status:200,headers:{'content-type':'application/json'}});
      throw new Error(`Unexpected source request: ${url}`);
    };

    const auth=await client.authenticate('https://jellyfin.example.test/jellyfin/','source-user','super-secret-password');
    assert.equal(auth.baseUrl,'https://jellyfin.example.test/jellyfin');
    assert.equal(auth.mediaServerType,'jellyfin');
    assert.equal(auth.jellyfinUserId,'user-123');
    assert.equal(auth.jellyfinUsername,'source-user');
    assert.equal(auth.accessToken,'normal-user-access-token-123456789');
    assert(!Object.prototype.hasOwnProperty.call(auth,'password'),'Authentication result must never retain the media-server password');
    assert.equal(new URL(calls[0].url).pathname,'/jellyfin/Users/AuthenticateByName','Jellyfin authentication must preserve the configured base path');
    assert.match(String(calls[0].options.headers.Authorization),/^MediaBrowser /,'Jellyfin external sign-in must retain MediaBrowser client authorization');

    const encrypted=client.encryptToken(auth.accessToken);
    assert(!encrypted.includes(auth.accessToken),'Access token must be encrypted at rest');
    assert.equal(client.decryptToken(encrypted),auth.accessToken);
    const libraries=await client.discoverLibraries({name:'External',media_server_type:'jellyfin',base_url:auth.baseUrl,jellyfin_user_id:auth.jellyfinUserId,access_token_encrypted:encrypted});
    assert.deepStrictEqual(libraries.map(x=>x.libraryId),['movies','shows'],'Only Movie/TV-compatible libraries should be offered for indexing');
    assert.equal(new URL(calls[1].url).pathname,'/jellyfin/Users/user-123/Views','Library discovery must preserve the configured Jellyfin base path');
    assert(calls[1].options.headers.Authorization.includes('normal-user-access-token'),'Jellyfin library discovery must authenticate as the ordinary source user');
    assert.equal(client.sourceUrl('https://jellyfin.example.test/jellyfin','/Items?Limit=1','jellyfin').pathname,'/jellyfin/Items');

    const revoked=await client.logoutToken(auth.baseUrl,'retired-token-123456789','External','jellyfin');
    assert.equal(revoked,true,'Retired Jellyfin direct-playback tokens must be revocable');
    assert.equal(new URL(calls[2].url).pathname,'/jellyfin/Sessions/Logout');

    const beforeEmby=calls.length;
    const emby=await client.authenticate('https://emby.example.test/media','emby-source','emby-password');
    assert.equal(emby.mediaServerType,'emby','404 on the Jellyfin contract must permit one-time Emby detection');
    assert.equal(emby.jellyfinUserId,'emby-user-1');
    assert.equal(new URL(calls[beforeEmby].url).pathname,'/media/Users/AuthenticateByName','provider detection must try the legacy-safe Jellyfin contract first on a neutral base URL');
    assert.equal(new URL(calls[beforeEmby+1].url).pathname,'/media/emby/Users/AuthenticateByName','Emby detection must preserve the reverse-proxy prefix');
    assert.match(String(calls[beforeEmby+1].options.headers.Authorization),/^Emby /,'Emby sign-in must use Emby client authorization');
    const embyEncrypted=client.encryptToken(emby.accessToken);
    const embyLibraries=await client.discoverLibraries({name:'External Emby',media_server_type:'emby',base_url:emby.baseUrl,jellyfin_user_id:emby.jellyfinUserId,access_token_encrypted:embyEncrypted});
    assert.deepStrictEqual(embyLibraries.map(x=>x.libraryId),['emovies']);
    const embyLibraryCall=calls.find(call=>new URL(call.url).pathname==='/media/emby/Users/emby-user-1/Views');
    assert(embyLibraryCall,'Emby library discovery must use the /emby API prefix');
    assert.equal(embyLibraryCall.options.headers['X-Emby-Token'],'emby-user-access-token-123456789','Emby user-token requests must use X-Emby-Token');
    assert.equal(embyLibraryCall.options.headers.Authorization,undefined,'Emby user-token requests must not fall back to Jellyfin Authorization');
    assert.equal(await client.logoutToken(emby.baseUrl,'retired-emby-token','External Emby','emby'),true);

    const explicitEmby=await client.authenticate('https://emby-root.example.test/emby','emby-root','pw');
    assert.equal(explicitEmby.mediaServerType,'emby','an /emby base path must be recognized before trying Jellyfin semantics');
    assert.equal(new URL(calls[calls.length-1].url).pathname,'/emby/Users/AuthenticateByName','an Emby API-root URL must not duplicate the /emby prefix');

    const root=path.join(__dirname,'..');
    const migration=fs.readFileSync(path.join(root,'db/migrations/071_stremio_external_media_server_type.sql'),'utf8');
    const pool=fs.readFileSync(path.join(root,'src/stremio/source-pool.js'),'utf8');
    assert(migration.includes("DEFAULT 'jellyfin'")&&migration.includes("CHECK (media_server_type IN ('jellyfin','emby'))"),'external source migration must preserve existing Jellyfin rows and constrain provider types');
    assert(pool.includes('mediaServerType=client.providerType(auth.mediaServerType)'),'first connect must persist the provider returned by authentication');
    assert(pool.includes('client.providerType(source.media_server_type)'),'reconnect/token rotation must use the stored provider instead of re-detecting it');

    await assert.rejects(()=>client.authenticate('ftp://jellyfin.example.test','x','y'),/HTTP or HTTPS/);
    await assert.rejects(()=>client.authenticate('https://user:pass@jellyfin.example.test','x','y'),/credentials/);
    console.log('stremio Jellyfin/Emby source client smoke: ok');
  }finally{outbound.safeFetch=original;}
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
