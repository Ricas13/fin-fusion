'use strict';

const assert = require('assert');
const http = require('http');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const operationsSettings = require('../src/platform/operations-settings');

process.env.SEERR_API_KEY = 'request-sync-test-key';
process.env.SEERR_API_USER_ID = '187';

const remote = {
    users: [
        {
            id: 41,
            email: 'existing@example.test',
            username: 'existing-user',
            permissions: 32,
            settings: { username: 'existing-user', email: 'existing@example.test', locale: 'en', movieQuotaLimit: 0, movieQuotaDays: 30, tvQuotaLimit: 0, tvQuotaDays: 30 }
        }
    ],
    createCalls: 0,
    deleteCalls: [],
    passwordCalls: [],
    permissionCalls: [],
    quotaCalls: [],
    failMainForId: null,
    raceEmail: null,
    raceArrivals: 0,
    raceRelease: null
};

function userById(id) { return remote.users.find(user => Number(user.id) === Number(id)); }
function readJson(req) { return new Promise((resolve, reject) => { const chunks=[]; req.on('data',chunk=>chunks.push(chunk)); req.on('end',()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{})}catch(error){reject(error)}}); req.on('error',reject); }); }
async function synchronizeRaceCreate(email) {
    if (!remote.raceEmail || String(email || '').toLowerCase() !== String(remote.raceEmail).toLowerCase()) return;
    remote.raceArrivals++;
    if (remote.raceArrivals === 1) {
        await new Promise(resolve => { remote.raceRelease = resolve; });
        return;
    }
    if (remote.raceArrivals === 2 && remote.raceRelease) {
        const release = remote.raceRelease;
        remote.raceRelease = null;
        release();
    }
}
const server = http.createServer(async (req,res)=>{
    try {
        if(req.headers['x-api-key']!==process.env.SEERR_API_KEY){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'bad api key'}));}
        if(req.headers['x-api-user']!==process.env.SEERR_API_USER_ID){res.writeHead(403,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'bad api actor'}));}
        const url=new URL(req.url,'http://request.test');
        if(req.method==='GET'&&url.pathname==='/api/v1/user'){
            const take=Math.max(1,Number(url.searchParams.get('take')||10)),skip=Math.max(0,Number(url.searchParams.get('skip')||0)),results=remote.users.slice(skip,skip+take).map(({settings,...user})=>user);
            res.writeHead(200,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({pageInfo:{pages:Math.max(1,Math.ceil(remote.users.length/take)),pageSize:take,results:remote.users.length,page:Math.floor(skip/take)+1},results}));
        }
        if(req.method==='POST'&&url.pathname==='/api/v1/user'){
            const body=await readJson(req);
            if(!body.email||!body.username||!body.password)throw new Error('missing local-user fields');
            await synchronizeRaceCreate(body.email);
            const normalizedEmail=String(body.email).toLowerCase();
            if(remote.users.some(user=>String(user.email).toLowerCase()===normalizedEmail)){res.writeHead(409,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'User already exists with submitted email.'}));}
            const created={id:100+remote.createCalls,email:normalizedEmail,username:body.username,permissions:32,settings:{username:body.username,email:normalizedEmail,locale:null,region:null,originalLanguage:null,movieQuotaLimit:0,movieQuotaDays:30,tvQuotaLimit:0,tvQuotaDays:30}};
            remote.createCalls++;
            remote.users.push(created);
            res.writeHead(201,{'Content-Type':'application/json'});
            const{settings,...publicUser}=created;
            return res.end(JSON.stringify(publicUser));
        }
        const userRoute=url.pathname.match(/^\/api\/v1\/user\/(\d+)$/);
        if(userRoute&&req.method==='GET'){
            const user=userById(userRoute[1]);
            if(!user){res.writeHead(404,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'User not found.'}));}
            const{settings,...publicUser}=user;
            res.writeHead(200,{'Content-Type':'application/json'});
            return res.end(JSON.stringify(publicUser));
        }
        if(userRoute&&req.method==='DELETE'){
            const index=remote.users.findIndex(user=>Number(user.id)===Number(userRoute[1]));
            if(index<0){res.writeHead(404,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'User not found.'}));}
            const [deleted]=remote.users.splice(index,1);
            remote.deleteCalls.push(deleted.id);
            res.writeHead(204);
            return res.end();
        }
        const permissions=url.pathname.match(/^\/api\/v1\/user\/(\d+)\/settings\/permissions$/);
        if(permissions){const user=userById(permissions[1]);if(!user)throw new Error('remote user missing');if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({permissions:user.permissions}));}if(req.method==='POST'){const body=await readJson(req);user.permissions=Number(body.permissions)||0;remote.permissionCalls.push({id:user.id,permissions:user.permissions});res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({permissions:user.permissions}));}}
        const main=url.pathname.match(/^\/api\/v1\/user\/(\d+)\/settings\/main$/);
        if(main){const user=userById(main[1]);if(!user)throw new Error('remote user missing');if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(user.settings));}if(req.method==='POST'){if(Number(remote.failMainForId)===Number(user.id)){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'forced request-user mutation failure'}));}const body=await readJson(req);if(body.locale==null||!String(body.locale).trim()){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'SQLITE_CONSTRAINT: NOT NULL constraint failed: user_settings.locale'}));}const normalizedBody={...body,email:String(body.email||'').toLowerCase()};user.settings={...user.settings,...normalizedBody};user.username=normalizedBody.username||user.username;user.email=normalizedBody.email||user.email;remote.quotaCalls.push({id:user.id,...normalizedBody});res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(user.settings));}}
        const password=url.pathname.match(/^\/api\/v1\/user\/(\d+)\/settings\/password$/);
        if(req.method==='POST'&&password){const body=await readJson(req);remote.passwordCalls.push({id:Number(password[1]),newPassword:body.newPassword});res.writeHead(204);return res.end();}
        res.writeHead(404,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:`unexpected ${req.method} ${url.pathname}`}));
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:error.message}));}
});
function listen(){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address()));});}
function closeServer(){return new Promise(resolve=>server.close(()=>resolve()));}
async function makeServer(name,slug){const result=await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled) VALUES($1,$2,'premium',$3,$3,'not-used',TRUE,100,100,'healthy',TRUE,TRUE,TRUE) RETURNING id`,[name,slug,`https://${slug}.example.test`]);return result.rows[0].id;}
async function makePlan(){const result=await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,server_class,active,visible,request_movie_quota_limit,request_movie_quota_days,request_tv_quota_limit,request_tv_quota_days) VALUES('request-test','Request Test','direct','month',30,600,'USD',3,TRUE,FALSE,TRUE,TRUE,'premium',TRUE,TRUE,2,30,2,30) RETURNING id`);return result.rows[0].id;}
async function makeCustomer({username,email=null,serverIds,planId}){const user=await query(`INSERT INTO app_users(email,username,password_hash,role,active) VALUES($1,$2,'test-hash','customer',TRUE) RETURNING id`,[email,username]),customer=await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.rows[0].id,username,email]);await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`,[customer.rows[0].id,planId]);let primary=true;for(const serverId of serverIds){await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary) VALUES($1,$2,$3,$4,FALSE,$5)`,[customer.rows[0].id,serverId,`${username}-${serverId}`,username,primary]);primary=false;}return customer.rows[0].id;}
function assertSummary(summary, expected, metrics = null){for(const[key,value]of Object.entries(expected))assert.strictEqual(summary[key],value,`summary ${key}`);assert(summary.metrics,'sync summary must expose operational metrics');assert.strictEqual(summary.metrics.usersInspected,summary.total);assert.strictEqual(summary.metrics.failed,summary.failed);assert(Number.isInteger(summary.metrics.elapsedMs)&&summary.metrics.elapsedMs>=0);if(metrics)for(const[key,value]of Object.entries(metrics))assert.strictEqual(summary.metrics[key],value,`metric ${key}`);}

(async()=>{
    const address=await listen(),requestUrl=`http://127.0.0.1:${address.port}`;
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_at) VALUES('platform',$1::jsonb,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=platform_settings.setting_value||EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({overseerrUrl:requestUrl})]);
    await operationsSettings.save({...operationsSettings.DEFAULTS,allowPrivateIntegrations:true,outboundTrustedHosts:['127.0.0.1']});
    await runtimeSettings.reload();
    const requestSettings=require('../src/integrations/request-service-settings');
    await requestSettings.useEnvironment();
    const connection=await requestSettings.testConnection();assert.strictEqual(connection.ok,true,'request connection test must send the configured Seerr API actor');
    const firstServer=await makeServer('Premium A','premium-a'),secondServer=await makeServer('Premium B','premium-b'),planId=await makePlan();
    const multiServerCustomer=await makeCustomer({username:'multi-user',email:'multi@example.test',serverIds:[firstServer,secondServer],planId});
    const noEmailCustomer=await makeCustomer({username:'no-email-user',serverIds:[firstServer],planId});
    const existingCustomer=await makeCustomer({username:'existing-user',email:'existing@example.test',serverIds:[secondServer],planId});
    const fixtureCustomerIds=[multiServerCustomer,noEmailCustomer,existingCustomer];
    const fixtureCustomerIdSet=new Set(fixtureCustomerIds.map(String));
    const requestSync=require('../src/integrations/request-user-sync'),candidates=(await requestSync.syncCandidates()).filter(row=>fixtureCustomerIdSet.has(String(row.customer_id)));
    assert.strictEqual(requestSync.protectedExternalUser({permissions:2},999),true,'Seerr administrators must never be deleted by entitlement cleanup');
    assert.strictEqual(requestSync.protectedExternalUser({permissions:0},1),true,'Seerr owner id 1 must never be deleted');
    assert.strictEqual(requestSync.protectedExternalUser({permissions:0},187),true,'configured Seerr API actor must never be deleted');
    assert.strictEqual(candidates.length,3,'multi-server Jellyfin accounts must collapse to one CAPTAiNFiN request user');const multi=candidates.find(row=>String(row.customer_id)===String(multiServerCustomer));assert.strictEqual(multi.active_server_count,2);assert.strictEqual(multi.request_movie_quota_limit,2);assert.strictEqual(multi.request_tv_quota_limit,2);
    const first=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(first,{total:3,created:2,linked:1,suspended:0,failed:0},{updated:3,unchanged:0});assert.strictEqual(remote.createCalls,2);assert.strictEqual(remote.users.length,3);for(const user of remote.users){assert.strictEqual(user.email,String(user.username).toLowerCase(),'Seerr local login identity must be the lowercase portal username');assert.strictEqual(user.settings.email,String(user.username).toLowerCase(),'Seerr main settings must retain the lowercase login identity');assert.strictEqual(user.settings.locale,'en','request sync must never submit a null Seerr locale');assert.strictEqual(user.settings.movieQuotaLimit,2);assert.strictEqual(user.settings.movieQuotaDays,30);assert.strictEqual(user.settings.tvQuotaLimit,2);assert.strictEqual(user.settings.tvQuotaDays,30);assert.strictEqual(user.permissions,32);}
    const linked=await requestSync.requestAccessForCustomer(existingCustomer);assert.strictEqual(Number(linked.external_user_id),41,'existing request user should be adopted by its legacy email rather than duplicated');assert.strictEqual(linked.external_email,'existing-user','adopted request users must migrate their Seerr login to the portal username');assert.strictEqual(linked.password_reset_required,false,'pre-existing request account password must not be reset');
    const noEmail=await requestSync.requestAccessForCustomer(noEmailCustomer);assert.strictEqual(noEmail.external_email,'no-email-user','email-optional CAPTAiNFiN users must use their portal username as the Seerr login');assert.strictEqual(noEmail.password_reset_required,true);
    const multiAccess=await requestSync.requestAccessForCustomer(multiServerCustomer);assert.strictEqual(multiAccess.external_email,'multi-user');assert.strictEqual(multiAccess.password_reset_required,true);
    const mutationCallsBeforeUnchanged=remote.quotaCalls.length,permissionCallsBeforeUnchanged=remote.permissionCalls.length;
    const second=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(second,{total:3,created:0,linked:3,suspended:0,failed:0},{updated:0,unchanged:3});assert.strictEqual(remote.createCalls,2);assert.strictEqual(remote.quotaCalls.length,mutationCallsBeforeUnchanged,'unchanged users must generate zero main-settings mutation calls');assert.strictEqual(remote.permissionCalls.length,permissionCallsBeforeUnchanged,'unchanged users must generate zero permission mutation calls');assert.strictEqual((await requestSync.requestAccessForCustomer(multiServerCustomer)).password_reset_required,true);
    await query(`UPDATE plans SET request_movie_quota_limit=4,request_tv_quota_limit=4 WHERE id=$1`,[planId]);remote.failMainForId=41;const partial=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(partial,{total:3,created:0,linked:2,suspended:0,failed:1},{updated:2,failed:1});assert(remote.users.filter(user=>user.id!==41).every(user=>user.settings.movieQuotaLimit===4&&user.settings.tvQuotaLimit===4),'one failed user must not prevent other users from converging');remote.failMainForId=null;const recovered=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(recovered,{total:3,created:0,linked:3,suspended:0,failed:0},{updated:1,unchanged:2});assert.strictEqual(userById(41).settings.movieQuotaLimit,4);
    await requestSync.setCustomerPassword(multiServerCustomer,'SharedPass-2026!');assert.strictEqual(remote.passwordCalls.length,1);assert.strictEqual(remote.passwordCalls[0].id,Number(multiAccess.external_user_id));assert.strictEqual(remote.passwordCalls[0].newPassword,'SharedPass-2026!');assert.strictEqual((await requestSync.requestAccessForCustomer(multiServerCustomer)).password_reset_required,false);
    const expiredExternalId=Number(multiAccess.external_user_id);
    await query(`UPDATE subscriptions SET current_period_end=NOW()-INTERVAL '1 minute',status='expired' WHERE customer_id=$1`,[multiServerCustomer]);const expired=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(expired,{total:3,created:0,linked:2,suspended:1,failed:0});assert.strictEqual(userById(expiredExternalId),undefined,'expired customer request account must be deleted from Seerr');assert(remote.deleteCalls.includes(expiredExternalId),'expired customer must be deleted by its exact linked Seerr id');const removed=await requestSync.requestAccessForCustomer(multiServerCustomer);assert.strictEqual(removed.external_user_id,null,'deleted request account binding must be cleared');assert.strictEqual(removed.access_suspended,true);assert.strictEqual(Number(removed.active_permissions),32,'last active request permissions may be retained locally for future policy fallback');assert.strictEqual(remote.users.length,2,'expiry must remove the linked Seerr request user');
    await query(`UPDATE plans SET request_movie_quota_limit=10,request_tv_quota_limit=15 WHERE id=$1`,[planId]);await query(`UPDATE subscriptions SET current_period_end=NOW()+INTERVAL '30 days',status='active' WHERE customer_id=$1`,[multiServerCustomer]);const renewed=await requestSync.syncSelected(fixtureCustomerIds);assertSummary(renewed,{total:3,created:1,linked:2,suspended:0,failed:0});const renewedAccess=await requestSync.requestAccessForCustomer(multiServerCustomer),renewedRemote=userById(renewedAccess.external_user_id);assert(renewedRemote,'renewed entitlement must create a fresh Seerr account');assert.notStrictEqual(Number(renewedAccess.external_user_id),expiredExternalId,'renewal must not restore the deleted Seerr identity');assert.strictEqual(renewedRemote.permissions,32,'renewal must restore request permissions on the fresh account');assert.strictEqual(renewedRemote.settings.movieQuotaLimit,10);assert.strictEqual(renewedRemote.settings.tvQuotaLimit,15);assert.strictEqual(renewedAccess.access_suspended,false);assert.strictEqual(renewedAccess.password_reset_required,true,'freshly recreated Seerr account must require the portal password to be applied');
    await query(`UPDATE plans SET request_movie_quota_limit=NULL,request_tv_quota_limit=NULL WHERE id=$1`,[planId]);await requestSync.syncSelected(fixtureCustomerIds);assert.strictEqual(renewedRemote.settings.movieQuotaLimit,0);assert.strictEqual(renewedRemote.settings.tvQuotaLimit,0);

    const mixedCaseCustomer=await makeCustomer({username:'MixedCaseUser',email:'mixed-case@example.test',serverIds:[firstServer],planId});
    const createCallsBeforeMixed=remote.createCalls;
    const mixedFirst=await requestSync.syncOneCustomer(mixedCaseCustomer);
    assert.strictEqual(mixedFirst.status,'synced');assert.strictEqual(mixedFirst.created,true);assert.strictEqual(remote.createCalls,createCallsBeforeMixed+1);
    const mixedAccess=await requestSync.requestAccessForCustomer(mixedCaseCustomer),mixedRemote=userById(mixedAccess.external_user_id);
    assert.strictEqual(mixedAccess.external_email,'mixedcaseuser','persisted Seerr login must be lowercase');assert.strictEqual(mixedAccess.external_username,'MixedCaseUser','display username casing must be preserved');assert.strictEqual(mixedRemote.email,'mixedcaseuser');assert.strictEqual(mixedRemote.username,'MixedCaseUser');
    const mixedQuotaCalls=remote.quotaCalls.length,mixedPermissionCalls=remote.permissionCalls.length;
    const mixedSecond=await requestSync.syncOneCustomer(mixedCaseCustomer);
    assert.strictEqual(mixedSecond.status,'synced');assert.strictEqual(mixedSecond.created,false);assert.strictEqual(mixedSecond.remoteChanged,false,'repeat sync must be idempotent after Seerr lowercases the login email');assert.strictEqual(remote.quotaCalls.length,mixedQuotaCalls);assert.strictEqual(remote.permissionCalls.length,mixedPermissionCalls);

    const collisionRemote={id:777,email:'collisionuser',username:'unrelated-user',permissions:64,settings:{username:'unrelated-user',email:'collisionuser',locale:'en',movieQuotaLimit:7,movieQuotaDays:30,tvQuotaLimit:9,tvQuotaDays:30}};
    remote.users.push(collisionRemote);
    const collisionCustomer=await makeCustomer({username:'CollisionUser',email:'collision-owner@example.test',serverIds:[firstServer],planId});
    const collisionCreates=remote.createCalls,collisionQuotaCalls=remote.quotaCalls.length,collisionPermissionCalls=remote.permissionCalls.length;
    const collision=await requestSync.syncOneCustomer(collisionCustomer);
    assert.strictEqual(collision.status,'failed','an unrelated account occupying the desired login must fail closed');assert.match(collision.error,/already used by another Seerr account/);assert.strictEqual(remote.createCalls,collisionCreates,'collision must not attempt a create');assert.strictEqual(remote.quotaCalls.length,collisionQuotaCalls,'collision must not mutate request settings');assert.strictEqual(remote.permissionCalls.length,collisionPermissionCalls,'collision must not mutate permissions');assert.strictEqual(collisionRemote.permissions,64);assert.strictEqual(collisionRemote.settings.movieQuotaLimit,7);
    const collisionAccess=await requestSync.requestAccessForCustomer(collisionCustomer);assert.strictEqual(collisionAccess.external_user_id,null,'collision must not adopt the unrelated Seerr user id');assert.strictEqual(collisionAccess.status,'failed');
    await query(`UPDATE subscriptions SET current_period_end=NOW()-INTERVAL '1 minute',status='expired' WHERE customer_id=$1`,[collisionCustomer]);const deleteCallsBeforeCollisionCleanup=remote.deleteCalls.length;const collisionExpired=await requestSync.syncOneCustomer(collisionCustomer);assert.strictEqual(collisionExpired.status,'ignored','invalid entitlement without a linked Seerr id must not delete by username or email');assert.strictEqual(remote.deleteCalls.length,deleteCallsBeforeCollisionCleanup);assert.strictEqual(userById(777),collisionRemote,'unlinked colliding Seerr user must remain untouched');

    const raceCustomer=await makeCustomer({username:'RaceUser',email:'race@example.test',serverIds:[firstServer],planId});
    remote.raceEmail='raceuser';
    remote.raceArrivals=0;
    const createCallsBeforeRace=remote.createCalls;
    const raceResults=await Promise.all([requestSync.syncOneCustomer(raceCustomer),requestSync.syncOneCustomer(raceCustomer)]);
    assert(raceResults.every(result=>result.status==='synced'),'both concurrent sync calls must converge successfully');
    assert.strictEqual(raceResults.filter(result=>result.created).length,1,'only one concurrent sync may create the remote request user');
    assert.strictEqual(raceResults.filter(result=>result.recoveredConcurrentCreate).length,1,'the losing create must adopt the concurrently-created remote user');
    assert.strictEqual(remote.createCalls,createCallsBeforeRace+1,'concurrent sync must create exactly one remote request user');
    const raceUsers=remote.users.filter(user=>String(user.email).toLowerCase()==='raceuser');
    assert.strictEqual(raceUsers.length,1,'concurrent sync must not duplicate username-based external identities');
    assert.strictEqual(raceUsers[0].username,'RaceUser','concurrent recovery must preserve display casing');
    const raceAccess=await requestSync.requestAccessForCustomer(raceCustomer);
    assert.strictEqual(Number(raceAccess.external_user_id),Number(raceUsers[0].id),'both sync paths must persist the same external identity');
    assert.strictEqual(raceAccess.external_email,'raceuser');
    assert.strictEqual(raceAccess.external_username,'RaceUser');
    assert.strictEqual(raceAccess.status,'synced');
    remote.raceEmail=null;

    const{compactRuns}=require('../src/platform/admin-provisioning'),grouped=compactRuns([{customer_id:multiServerCustomer,customer_name:'multi-user',action:'reconcile',status:'succeeded',detail:{},started_at:'2026-08-14T20:00:00Z'},{customer_id:multiServerCustomer,customer_name:'multi-user',action:'reconcile',status:'succeeded',detail:{},started_at:'2026-08-14T19:55:00Z'},{customer_id:multiServerCustomer,customer_name:'multi-user',action:'reconcile',status:'succeeded',detail:{},started_at:'2026-08-14T19:50:00Z'}]);assert.strictEqual(grouped.length,1);assert.strictEqual(grouped[0].repeat_count,3);console.log('request user sync smoke: ok');
})().finally(async()=>{await closeServer().catch(()=>{});await getPool().end();}).catch(()=>{console.error('request user sync smoke failed');process.exitCode=1;});
