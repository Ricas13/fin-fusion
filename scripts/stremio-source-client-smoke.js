'use strict';

const assert=require('assert');
process.env.JELLYFIN_ENCRYPTION_KEY='42'.repeat(32);
const outbound=require('../src/security/outbound-url-policy');
const client=require('../src/stremio/source-client');

(async()=>{
  const original=outbound.safeFetch;
  const calls=[];
  try{
    outbound.safeFetch=async(url,options={})=>{
      calls.push({url:String(url),options});
      if(String(url).includes('/Users/AuthenticateByName'))return new Response(JSON.stringify({AccessToken:'normal-user-access-token-123456789',User:{Id:'user-123',Name:'source-user'}}),{status:200,headers:{'content-type':'application/json'}});
      if(String(url).includes('/Users/user-123/Views'))return new Response(JSON.stringify({Items:[{Id:'movies',Name:'Movies',CollectionType:'movies'},{Id:'shows',Name:'TV',CollectionType:'tvshows'},{Id:'music',Name:'Music',CollectionType:'music'}]}),{status:200,headers:{'content-type':'application/json'}});
      throw new Error(`Unexpected source request: ${url}`);
    };

    const auth=await client.authenticate('https://jellyfin.example.test/','source-user','super-secret-password');
    assert.equal(auth.baseUrl,'https://jellyfin.example.test');
    assert.equal(auth.jellyfinUserId,'user-123');
    assert.equal(auth.jellyfinUsername,'source-user');
    assert.equal(auth.accessToken,'normal-user-access-token-123456789');
    assert(!Object.prototype.hasOwnProperty.call(auth,'password'),'Authentication result must never retain the Jellyfin password');
    const login=JSON.parse(calls[0].options.body);
    assert.equal(login.Username,'source-user');
    assert.equal(login.Pw,'super-secret-password');

    const encrypted=client.encryptToken(auth.accessToken);
    assert(!encrypted.includes(auth.accessToken),'Access token must be encrypted at rest');
    assert.equal(client.decryptToken(encrypted),auth.accessToken);
    const libraries=await client.discoverLibraries({name:'External',base_url:auth.baseUrl,jellyfin_user_id:auth.jellyfinUserId,access_token_encrypted:encrypted});
    assert.deepStrictEqual(libraries.map(x=>x.libraryId),['movies','shows'],'Only Movie/TV-compatible libraries should be offered for indexing');
    assert(calls[1].options.headers.Authorization.includes('normal-user-access-token'),'Library discovery must authenticate as the ordinary Jellyfin source user');

    await assert.rejects(()=>client.authenticate('ftp://jellyfin.example.test','x','y'),/HTTP or HTTPS/);
    await assert.rejects(()=>client.authenticate('https://user:pass@jellyfin.example.test','x','y'),/credentials/);
    console.log('stremio source client smoke: ok');
  }finally{outbound.safeFetch=original;}
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
