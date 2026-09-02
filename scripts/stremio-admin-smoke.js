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
const managedAdmin=read('src/platform/admin-stremio-managed-sources.js');
const externalConfig=read('src/stremio/source-admin-config.js');
const adminServers=read('src/platform/admin-servers.js');
const delivery=read('src/platform/admin-plan-delivery.js');
const sourcePool=read('src/stremio/source-pool.js');
const sourceClient=read('src/stremio/source-client.js');
const sourceIndex=read('src/stremio/source-index.js');
const managedIndex=read('src/stremio/media-index.js');
const managedLibraries=read('src/stremio/managed-library-selection.js');
const indexMaintenance=read('src/stremio/index-maintenance.js');
const capabilityCss=read('public/css/admin-capability.css');
const htmlCore=read('src/platform/admin-html-core.js');
const tokenMaintenance=read('src/stremio/external-token-maintenance.js');
const automationJobs=read('src/automation/jobs.js');
const automationWorker=read('scripts/automation-worker.js');
const runtimeSettings=read('src/stremio/runtime-settings.js');
const migration=read('db/migrations/000_database_baseline.sql');
const rotationMigration=read('db/migrations/004_stremio_source_token_rotation.sql');
const maintenanceMigration=read('db/migrations/020_stremio_external_maintenance.sql');
const managedLibraryMigration=read('db/migrations/021_stremio_managed_library_selection.sql');

assert(router.includes('createAdminStremioSourcesRouter')&&router.includes('router.use(createAdminStremioSourcesRouter())'),'Stremio source router must be mounted');
assert(adminServers.includes('SERVER_ID_PARAM')&&adminServers.includes('/admin/servers/${SERVER_ID_PARAM}/edit'),'generic Jellyfin server routes must be UUID-constrained so /admin/servers/stremio is not parsed as a server ID');
assert(nav.includes("['stremio-sources','Stremio','/admin/servers/stremio']"),'Stremio workspace must expose one canonical Stremio control room');
assert(nav.includes("'stremio-playback':Object.freeze({kind:'setting',groupKey:'servers',parentKey:'stremio-sources'")&&nav.includes("['stremio-playback','IP access','/admin/stremio/playback']"),'Stremio IP access must remain routable as a parent-owned setting under the Stremio control room');
assert(nav.includes("'stremio-settings':'stremio-sources'")&&nav.includes("'stremio-source-pool':'stremio-sources'")&&nav.includes("'stremio-managed-sources':'stremio-sources'"),'legacy Stremio navigation aliases must resolve to the Stremio control room');
assert(!settings.includes('href="/admin/settings/stremio"'),'Settings → Integrations must not duplicate the Stremio workflow');
assert(legacy.includes("res.redirect(302,'/admin/servers/stremio')"),'legacy Stremio settings URLs must land on the single Stremio control centre');
assert(managedAdmin.includes("res.redirect(302,'/admin/servers/stremio')"),'old managed Stremio URL must redirect to the single control centre');

for(const phrase of ['Manage Stremio','Managed Jellyfin sources','External Jellyfin sources','Libraries included in Stremio','Clear all indexes & rebuild','Managed Stremio activity','Hidden Jellyfin user','Add external Jellyfin source'])assert(sources.includes(phrase),`Stremio control centre missing: ${phrase}`);
assert(sources.includes('capabilitySummary')&&sources.includes('capabilityTable')&&sources.includes('capabilitySourceDisclosure'),'Stremio must use the shared compact capability-page pattern');
assert(htmlCore.includes('/css/admin-capability.css'),'shared capability-page stylesheet must be loaded globally');
assert(capabilityCss.includes('grid-template-columns:repeat(5,minmax(0,1fr))'),'library choices must use the dense wide-screen grid');
const renderedBody=sources.slice(sources.indexOf('const body=`<div class="capabilityPage">'));
assert(renderedBody.indexOf('<h2>Managed Jellyfin sources</h2>')<renderedBody.indexOf('<h2>External Jellyfin sources</h2>')&&renderedBody.indexOf('<h2>External Jellyfin sources</h2>')<renderedBody.indexOf('${activitySection(d.activity)}'),'page hierarchy must be summary → managed → external → activity');
assert(!sources.includes('Recent connection attempts')&&!sources.includes('sourceInlineManage'),'Stremio must not retain the old multi-panel/connection-attempt page shape');
assert(sources.includes("r.get('/admin/servers/stremio/:id',(_req,res)=>res.redirect(302,'/admin/servers/stremio'))"),'external source detail URLs must collapse back into the single control centre');
assert(sources.includes('Stremio is a control plane, not a video proxy.')&&sources.toLowerCase().includes('media bytes never pass through the portal'),'operator UI must preserve the no-byte-proxy boundary');

assert(sources.includes('name="baseUrl"')&&sources.includes('name="username"')&&sources.includes('name="password"'),'External source form must use Jellyfin URL + ordinary user credentials');
assert(!sources.includes('name="accessToken"')&&!sources.includes('name="jellyfinUserId"'),'Operators must not manually paste Jellyfin access tokens/user IDs');
assert(sources.includes("routeRateLimit.middleware({scope:'admin-stremio-sources'"),'Source mutations must use the persistent admin rate limiter');
assert(sources.includes('Attempt log ID')&&sources.includes('failureLogPayload')&&sources.includes('stremio_source_attempt'),'External connection failures must retain traceable audit attempt IDs');
assert(sourcePool.includes('discoveryWarning')&&sourcePool.includes('sourcePersisted:true'),'Library discovery failure must preserve an authenticated external source for diagnosis/retry');
assert(sources.includes("r.post('/admin/servers/stremio/:id/configure'")&&sources.includes('sourceAdminConfig.configure'),'single page must provide inline external source enable/priority updates');
assert(externalConfig.includes('priority must be between 1 and 10000')&&externalConfig.includes('enabled=$2,priority=$3'),'external inline configuration must validate and persist source participation/priority');
assert(sourceIndex.includes('SELECT s.id,s.name,s.enabled,s.priority,s.auth_state'),'external source read model must return persisted priority for inline editing');
assert(sources.includes("r.post('/admin/servers/stremio/:id/reindex'")&&sources.includes('sourceIndex.clearAndQueue'),'external sources must retain per-source local-index clear/rebuild');
assert(sources.includes('External fallback playback goes directly to this Jellyfin server'),'external source UI must clearly describe direct upstream playback');

assert(managedLibraryMigration.includes('CREATE TABLE IF NOT EXISTS stremio_managed_source_libraries')&&managedLibraryMigration.includes('PRIMARY KEY(server_id, library_id)'),'managed Stremio library choices must have dedicated persistent state');
assert(managedLibraries.includes("'/Library/VirtualFolders'")&&managedLibraries.includes('SUPPORTED_TYPES'),'managed library choices must come from the managed Jellyfin server library catalogue');
assert(managedLibraries.includes("'admin.stremio.managed_libraries.update'")&&managedLibraries.includes('selected=EXCLUDED.selected'),'managed library saves must be explicit and audited');
assert(sources.includes("r.post('/admin/servers/stremio/managed/:id/libraries'")&&sources.includes('managedMediaIndex.saveLibrariesAndReset'),'managed source rows must save library toggles and reset their local index');
assert(sources.includes("r.post('/admin/servers/stremio/managed/:id/refresh-libraries'")&&sources.includes('managedLibraries.refresh'),'managed source rows must refresh available libraries inline');
assert(managedIndex.includes('managedLibraries.indexFilter(serverId)')&&managedIndex.includes("qs.set('ParentId',String(parentId))"),'managed index must honor the selected library allow-list');
assert(managedIndex.includes('if(!filter.configured)return[null]'),'upgrades must preserve all-library managed indexing until an operator establishes explicit selections');
assert(managedIndex.includes('clearAndReset'),'managed rows must support a clean local re-index without touching Jellyfin media');

assert(indexMaintenance.includes('DELETE FROM stremio_media_index')&&indexMaintenance.includes('DELETE FROM stremio_source_media_index'),'global rebuild must clear only CAPTAiNFiN managed/external lookup indexes');
assert(indexMaintenance.includes("status='running'")&&indexMaintenance.includes('Wait for active indexing'),'global destructive index cleanup must refuse to run while indexing is active');
assert(sources.includes("r.post('/admin/servers/stremio/reindex-all'")&&sources.includes('indexMaintenance.clearAllAndQueue'),'admin must expose one-click all-source clean rebuild');

assert(sources.includes('JOIN customers c ON c.id=sma.customer_id')&&sources.includes('JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id'),'activity must correlate hidden Jellyfin accounts to real portal customers');
assert(sources.includes('ja.jellyfin_username hidden_username')&&sources.includes('/admin/users/${esc(row.customer_id)}'),'activity rows must display the hidden Jellyfin username and link straight to customer management');
assert(sources.includes('LIMIT $1 OFFSET $2')&&sources.includes('activityPage'),'managed Stremio activity must be paginated');

assert(sourceClient.includes('/Users/AuthenticateByName')&&sourceClient.includes('/Views?IncludeExternalContent=false'),'Source client must use normal Jellyfin user authentication and discover visible libraries');
assert(sourceClient.includes("TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY'")&&sourceClient.includes("LEGACY_TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY'"),'External tokens must use the normal Jellyfin encryption key while retaining legacy decrypt compatibility');
assert(sourceClient.includes('logoutToken')&&sourceClient.includes('/Sessions/Logout'),'external playback tokens must be explicitly revocable');
assert(tokenMaintenance.includes('DEFAULT_ROTATION_HOURS=4')&&tokenMaintenance.includes('TOKEN_GRACE_HOURS=1'),'External tokens must rotate on the four-hour policy with a one-hour old-token grace');
assert(tokenMaintenance.includes('stremio_source_retired_tokens')&&tokenMaintenance.includes('revokeRetiredTokens'),'Old direct-playback tokens must be queued and revoked after grace');
assert(sources.includes('tokenRotationEnabled')&&sources.includes('value="4"'),'compact connection controls must preserve configurable four-hour token rotation');

assert(sourceIndex.includes('INCREMENTAL_HOURS=3')&&sourceIndex.includes('FULL_RECONCILE_HOURS=84'),'Index policy must remain three-hour incremental plus twice-weekly full reconciliation');
assert(sourceIndex.includes("MinDateLastSaved")&&sourceIndex.includes("EnableImages:'false'")&&sourceIndex.includes('PAGE_SIZE=250'),'External indexing must remain incremental and low-footprint');
assert(automationJobs.indexOf('stremioSourceIndex.indexDueSources()')<automationJobs.indexOf('stremioMediaIndex.indexAll()'),'External Jellyfin source indexing must run before the managed Stremio catalogue');
assert(automationJobs.includes('stremio_external_tokens')&&automationJobs.includes('stremioExternalTokens.maintain'),'External token maintenance must remain a dedicated automation job');
assert(automationWorker.includes('stremio_external_tokens:300')&&automationWorker.includes('stremio_media_index:10800'),'Worker defaults must retain five-minute token housekeeping and three-hour indexing');
assert(sourcePool.includes('plan_stremio_sources')&&sourcePool.includes('if(explicit)return mapped.rows'),'Explicit plan mappings must be strict external source allow-lists');
assert(delivery.includes('Stremio sources')&&delivery.includes('/admin/plans/${esc(p.id)}/stremio-sources'),'Plan Delivery must own external source selection');

for(const table of ['stremio_source_libraries','stremio_source_media_index','stremio_source_index_state','plan_stremio_sources'])assert(migration.includes(`CREATE TABLE public.${table}`)||migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`),`Migration missing ${table}`);
assert(runtimeSettings.includes('externalSources')&&runtimeSettings.includes('externalReadyIndexes')&&runtimeSettings.includes('eligibleSources'),'Runtime readiness must account for external and managed Stremio sources');
assert(rotationMigration.includes('password_encrypted')&&rotationMigration.includes('token_rotation_enabled'),'Token rotation migration must retain encrypted password storage');
assert(maintenanceMigration.includes('stremio_source_retired_tokens')&&maintenanceMigration.includes("'stremio_external_tokens',TRUE,300")&&maintenanceMigration.includes("'stremio_media_index',TRUE,10800"),'External maintenance migration must persist token grace and automation cadences');

console.log('stremio admin sources smoke: ok');
