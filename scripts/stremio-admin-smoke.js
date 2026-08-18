'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const router=read('src/platform/router.js');
const nav=read('src/platform/admin-nav.js');
const settings=read('src/platform/admin-original-settings.js');
const legacy=read('src/platform/admin-stremio.js');
const sources=read('src/platform/admin-stremio-sources.js');
const adminServers=read('src/platform/admin-servers.js');
const delivery=read('src/platform/admin-plan-delivery.js');
const sourcePool=read('src/stremio/source-pool.js');
const sourceClient=read('src/stremio/source-client.js');
const sourceIndex=read('src/stremio/source-index.js');
const runtimeSettings=read('src/stremio/runtime-settings.js');
const migration=read('db/migrations/000_database_baseline.sql');

assert(router.includes('createAdminStremioSourcesRouter')&&router.includes('router.use(createAdminStremioSourcesRouter())'),'Servers-owned Stremio Sources router must be mounted');
assert(adminServers.includes('SERVER_ID_PARAM')&&adminServers.includes('/admin/servers/${SERVER_ID_PARAM}/edit'),'Generic Jellyfin server routes must be UUID-constrained so /admin/servers/stremio is not parsed as a server ID');
assert(nav.includes("['stremio-sources','Stremio','/admin/servers/stremio']"),'Stremio must be a Servers navigation destination');
assert(nav.includes("'stremio-settings':'stremio-sources'")&&nav.includes("'stremio-source-pool':'stremio-sources'"),'Legacy Stremio navigation must resolve to Servers → Stremio');
assert(!settings.includes('href="/admin/settings/stremio"'),'Settings → Integrations must not duplicate the Stremio Sources workflow');
assert(legacy.includes("res.redirect(302,'/admin/servers/stremio')"),'Legacy Stremio settings URL must redirect to the Servers-owned Stremio workflow');

for(const phrase of ['Add Jellyfin source','Connect Jellyfin source','Libraries to index','Sync now','Incremental every 6 hours','full reconciliation','Password is not stored'])assert(sources.includes(phrase),`Stremio Sources UI missing: ${phrase}`);
assert(sources.includes('name="baseUrl"')&&sources.includes('name="username"')&&sources.includes('name="password"'),'External source form must use Jellyfin URL + ordinary user credentials');
assert(!sources.includes('name="accessToken"')&&!sources.includes('name="jellyfinUserId"'),'Operators must not manually paste Jellyfin access tokens/user IDs');
assert(sources.includes('name="libraryId"'),'Source detail must expose explicit library selection');
assert(sources.includes("routeRateLimit.middleware({scope:'admin-stremio-sources'"),'Source mutations must use the persistent admin rate limiter');
assert(!sources.includes('Managed Jellyfin sources'),'Managed Jellyfin servers must not be offered as Stremio sources');
assert(!sources.includes('Use for Stremio'),'Normal Jellyfin server administration must not leak into the manual Stremio source workflow');
assert(!sources.includes('managedServers()'),'Stremio Sources must not query the normal Jellyfin server fleet for candidates');
assert(sources.includes('independent from Servers → Servers'),'UI must explain that Stremio upstreams are configured independently');
assert(sources.includes('Attempt log ID')&&sources.includes('[stremio-source-attempt]')&&sources.includes('failureLogPayload'),'Manual connection failures must show an attempt ID and emit structured Docker logs');
assert(sourcePool.includes('discoveryWarning')&&sourcePool.includes('sourcePersisted:true'),'Library discovery failure must preserve an authenticated source for diagnosis/retry');
assert(sources.includes('source was saved')&&sources.includes('library discovery needs attention'),'Admin UI must explain partial source admission without pretending discovery succeeded');

assert(sourceClient.includes('/Users/AuthenticateByName')&&sourceClient.includes('/Views?IncludeExternalContent=false'),'Source client must use normal Jellyfin user authentication and discover visible libraries');
assert(sourceClient.includes("TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY'")&&sourceClient.includes("LEGACY_TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY'"),'External tokens must use the normal Jellyfin encryption key while retaining legacy decrypt compatibility');
assert(!sourceClient.includes('encryptWithEnv(password')&&!sourcePool.includes('password_encrypted'),'Jellyfin source passwords must never be persisted');

assert(sourceIndex.includes('INCREMENTAL_HOURS=6')&&sourceIndex.includes('FULL_RECONCILE_DAYS=7'),'Index policy must be six-hour incremental plus seven-day full reconciliation');
assert(sourceIndex.includes("MinDateLastSaved")&&sourceIndex.includes("EnableImages:'false'")&&sourceIndex.includes('PAGE_SIZE=250'),'Indexing must be incremental and low-footprint');
assert(sourcePool.includes('plan_stremio_sources')&&sourcePool.includes('if(explicit)return mapped.rows'),'Explicit plan mappings must be strict source allow-lists');
assert(delivery.includes('Stremio sources')&&delivery.includes('/admin/plans/${esc(p.id)}/stremio-sources'),'Plan Delivery must own source selection');
assert(delivery.includes('Lower priority numbers are tried first'),'Plan UI must explain source ordering');

for(const table of ['stremio_source_libraries','stremio_source_media_index','stremio_source_index_state','plan_stremio_sources'])assert(migration.includes(`CREATE TABLE public.${table}`)||migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`),`Migration missing ${table}`);
assert(migration.includes('either selected shared sources or a managed Jellyfin delivery identity'),'Entitlement integrity must support source-only and legacy managed delivery');
assert(runtimeSettings.includes('externalSources')&&runtimeSettings.includes('externalReadyIndexes')&&runtimeSettings.includes('eligibleSources'),'Runtime readiness must be based on usable Stremio sources');

console.log('stremio admin sources smoke: ok');
