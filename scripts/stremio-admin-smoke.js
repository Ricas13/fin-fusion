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
const tokenMaintenance=read('src/stremio/external-token-maintenance.js');
const automationJobs=read('src/automation/jobs.js');
const automationWorker=read('scripts/automation-worker.js');
const runtimeSettings=read('src/stremio/runtime-settings.js');
const migration=read('db/migrations/000_database_baseline.sql');
const rotationMigration=read('db/migrations/004_stremio_source_token_rotation.sql');
const maintenanceMigration=read('db/migrations/020_stremio_external_maintenance.sql');

assert(router.includes('createAdminStremioSourcesRouter')&&router.includes('router.use(createAdminStremioSourcesRouter())'),'Servers-owned Stremio router must be mounted');
assert(adminServers.includes('SERVER_ID_PARAM')&&adminServers.includes('/admin/servers/${SERVER_ID_PARAM}/edit'),'Generic Jellyfin server routes must be UUID-constrained so /admin/servers/stremio is not parsed as a server ID');
assert(nav.includes("['stremio-sources','Stremio','/admin/servers/stremio']"),'Stremio must be a single Servers navigation destination');
assert(nav.includes("'stremio-settings':'stremio-sources'")&&nav.includes("'stremio-source-pool':'stremio-sources'"),'Legacy Stremio navigation must resolve to Servers → Stremio');
assert(!settings.includes('href="/admin/settings/stremio"'),'Settings → Integrations must not duplicate the Stremio workflow');
assert(legacy.includes("res.redirect(302,'/admin/servers/stremio')"),'Legacy Stremio settings URLs must land on the single Stremio control centre');
assert(managedAdmin.includes("res.redirect(302,'/admin/servers/stremio')"),'old managed Stremio URL must redirect to the single control centre');

for(const phrase of ['Your Jellyfin servers','External Jellyfin servers','Add external Jellyfin server','Connect external server','Recent connection attempts','Libraries','Sync now','Clear index & rebuild','Reconnect','Rotate direct-playback token automatically'])assert(sources.includes(phrase),`Stremio control centre/compatibility UI missing: ${phrase}`);
assert(sources.includes('name="baseUrl"')&&sources.includes('name="username"')&&sources.includes('name="password"'),'External source form must use Jellyfin URL + ordinary user credentials');
assert(!sources.includes('name="accessToken"')&&!sources.includes('name="jellyfinUserId"'),'Operators must not manually paste Jellyfin access tokens/user IDs');
assert(sources.includes('name="libraryId"'),'External source management must expose explicit library selection');
assert(sources.includes("routeRateLimit.middleware({scope:'admin-stremio-sources'"),'Source mutations must use the persistent admin rate limiter');
assert(sources.indexOf('Your Jellyfin servers')<sources.indexOf('External Jellyfin servers'),'managed servers must be presented before external servers');
assert(sources.indexOf('External Jellyfin servers')<sources.indexOf('Recent connection attempts'),'recent connection attempts must follow both server groups');
assert(sources.includes('customers are not told where results came from')||sources.includes('Customers see only stream results'),'admin UI must preserve source-neutral customer presentation');
assert(sources.includes('Attempt log ID')&&sources.includes('[stremio-source-attempt]')&&sources.includes('failureLogPayload'),'External connection failures must show an attempt ID and emit structured Docker logs');
assert(sources.includes('Recent connection attempts')&&sources.includes('recentAttempts')&&sources.includes('audit_log')&&sources.includes('stremio_source_attempt'),'External connection attempts must persist to the audit log and render on the Stremio page');
assert(sourcePool.includes('discoveryWarning')&&sourcePool.includes('sourcePersisted:true'),'Library discovery failure must preserve an authenticated external source for diagnosis/retry');
assert(sources.includes('source was saved')&&sources.includes('library discovery needs attention'),'Admin UI must explain partial external source admission without pretending discovery succeeded');
assert(sources.includes("r.post('/admin/servers/stremio/:id/configure'")&&sources.includes('sourceAdminConfig.configure'),'single page must provide inline external source enable/priority updates');
assert(externalConfig.includes('priority must be between 1 and 10000')&&externalConfig.includes('enabled=$2,priority=$3'),'external inline configuration must validate and persist source participation/priority');
assert(sourceIndex.includes('SELECT s.id,s.name,s.enabled,s.priority,s.auth_state'),'external source read model must return persisted priority for inline editing');
assert(sources.includes('sourceInlineManage')&&sources.includes('sourceManageGrid'),'external library/index/connection administration must expand inline on the main Stremio page');
assert(sources.includes('name="returnTo" value="main"'),'inline external management mutations must return to the single Stremio page');
assert(sources.includes("successTarget(req,req.params.id,'Libraries saved. A full index has been queued.')"),'inline library updates must return through the single-page target helper');
assert(sources.includes("successTarget(req,req.params.id,'Jellyfin source reconnected. A full index has been queued.')"),'inline reconnect must return through the single-page target helper');
assert(!sources.includes('href="/admin/servers/stremio/${esc(source.id)}">Manage'),'main Stremio table must not require a separate external Manage page');
assert(sources.includes('Expand the source and choose the libraries to index.'),'new external sources must return to inline management after connect');
assert(sources.includes("r.post('/admin/servers/stremio/:id/reindex'")&&sources.includes('sourceIndex.clearAndQueue'),'admin must expose a local-index clear-and-full-rebuild action');

assert(sourceClient.includes('/Users/AuthenticateByName')&&sourceClient.includes('/Views?IncludeExternalContent=false'),'Source client must use normal Jellyfin user authentication and discover visible libraries');
assert(sourceClient.includes("TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY'")&&sourceClient.includes("LEGACY_TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY'"),'External tokens must use the normal Jellyfin encryption key while retaining legacy decrypt compatibility');
assert(sourceClient.includes('PASSWORD_PREFIX')&&sourceClient.includes('encryptPassword')&&sourceClient.includes('decryptPassword'),'Optional rotation passwords must use a separate encrypted purpose');
assert(sourceClient.includes('logoutToken')&&sourceClient.includes('/Sessions/Logout'),'retired external direct-playback tokens must be explicitly revocable');
assert(tokenMaintenance.includes('DEFAULT_ROTATION_HOURS=4')&&tokenMaintenance.includes('TOKEN_GRACE_HOURS=1'),'External tokens must rotate on the four-hour policy with a one-hour old-token grace');
assert(tokenMaintenance.includes('stremio_source_retired_tokens')&&tokenMaintenance.includes('revokeRetiredTokens'),'Old direct-playback tokens must be queued and revoked after grace');
assert(tokenMaintenance.includes('rotateDueTokens')&&tokenMaintenance.includes('client.authenticate'),'Automatic token rotation must mint fresh Jellyfin user tokens rather than reusing old credentials');
assert(sources.includes('passwordStored')&&sources.includes('tokenRotationEnabled'),'Admin audit metadata must record whether encrypted rotation storage was requested without storing raw passwords');
assert(sources.includes('value="4"')&&sources.includes('old token remains usable for up to 1 hour'),'Admin defaults/help must explain the four-hour rotation and grace window');

assert(sourceIndex.includes('INCREMENTAL_HOURS=3')&&sourceIndex.includes('FULL_RECONCILE_HOURS=84'),'Index policy must be three-hour incremental plus twice-weekly full reconciliation');
assert(sourceIndex.includes("MinDateLastSaved")&&sourceIndex.includes("EnableImages:'false'")&&sourceIndex.includes('PAGE_SIZE=250'),'Indexing must be incremental and low-footprint');
assert(sourceIndex.includes('clearAndQueue')&&sourceIndex.includes("DELETE FROM stremio_source_media_index WHERE source_id=$1"),'Clean rebuild must delete only the selected external source local index');
assert(sourceIndex.includes('refreshProgress')&&sourceIndex.includes('Stremio source index started')&&sourceIndex.includes('Stremio source index completed'),'Source indexing must expose live progress and operational logs');
assert(automationJobs.indexOf('stremioSourceIndex.indexDueSources()')<automationJobs.indexOf('stremioMediaIndex.indexAll()'),'External Jellyfin source indexing must run before the managed Stremio catalogue');
assert(automationJobs.includes('stremio_external_tokens')&&automationJobs.includes('stremioExternalTokens.maintain'),'External token maintenance must be a dedicated automation job');
assert(automationWorker.includes('stremio_external_tokens:300')&&automationWorker.includes('stremio_media_index:10800'),'Worker defaults must sweep external token maintenance every five minutes and media indexing every three hours');
assert(sourcePool.includes('plan_stremio_sources')&&sourcePool.includes('if(explicit)return mapped.rows'),'Explicit plan mappings must be strict external source allow-lists');
assert(delivery.includes('Stremio sources')&&delivery.includes('/admin/plans/${esc(p.id)}/stremio-sources'),'Plan Delivery must own external source selection');
assert(delivery.includes('Lower priority numbers are tried first'),'Plan UI must explain source ordering');

for(const table of ['stremio_source_libraries','stremio_source_media_index','stremio_source_index_state','plan_stremio_sources'])assert(migration.includes(`CREATE TABLE public.${table}`)||migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`),`Migration missing ${table}`);
assert(migration.includes('either selected shared sources or a managed Jellyfin delivery identity'),'Entitlement integrity must support source-only and managed delivery');
assert(runtimeSettings.includes('externalSources')&&runtimeSettings.includes('externalReadyIndexes')&&runtimeSettings.includes('eligibleSources'),'Runtime readiness must account for external and managed Stremio sources');
assert(rotationMigration.includes('password_encrypted')&&rotationMigration.includes('token_rotation_enabled')&&rotationMigration.includes('stremio_sources_token_rotation_idx'),'Token rotation migration must add encrypted password storage and due-token lookup');
assert(maintenanceMigration.includes('stremio_source_retired_tokens')&&maintenanceMigration.includes("'stremio_external_tokens',TRUE,300")&&maintenanceMigration.includes("'stremio_media_index',TRUE,10800"),'External maintenance migration must persist token grace and the new automation cadences');

console.log('stremio admin sources smoke: ok');
