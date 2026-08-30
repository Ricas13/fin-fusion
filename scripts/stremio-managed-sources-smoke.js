'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/016_stremio_managed_source_foundation.sql');
const managed=read('src/stremio/managed-sources.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourcePool=read('src/stremio/source-pool.js');
const tokenMaintenance=read('src/stremio/external-token-maintenance.js');
const operationLock=read('src/stremio/operation-lock.js');
const admin=read('src/platform/admin-stremio-managed-sources.js');
const sources=read('src/platform/admin-stremio-sources.js');
const externalConfig=read('src/stremio/source-admin-config.js');
const composition=read('src/platform/admin-route-composition.js');
const nav=read('src/platform/admin-nav.js');
const html=read('src/platform/admin-html.js');

assert(migration.includes('stremio_priority integer DEFAULT 100 NOT NULL'),'managed source priority migration missing');
assert(migration.includes('CREATE TABLE IF NOT EXISTS stremio_managed_accounts'),'multi-server managed-account mapping missing');
assert(migration.includes('UNIQUE(entitlement_id, server_id)'),'managed account must be unique per entitlement/server');
assert(migration.includes('jellyfin_access_token_encrypted'),'legacy managed entitlement migration must preserve restricted playback tokens');
assert(managed.includes('registry.mediaProvider.credentialProbeEndpoint(type)'),'managed source enablement must validate the stored backend credential through the provider adapter');
assert(!managed.includes("normalizeType(server.media_server_type)!=='jellyfin'"),'managed Stremio must not retain the old Emby rejection gate');
assert(!managed.includes("COALESCE(media_server_type,'jellyfin')='jellyfin'"),'managed Stremio source selection must not silently exclude Emby');
assert(managed.includes('media_server_type'),'managed source rows must carry the provider discriminator');
assert(managed.includes('api_configured'),'managed source view may expose credential presence but not its value');
assert(managed.includes('public_url IS NOT NULL'),'managed direct playback sources must require a public URL');
assert(managed.includes('ORDER BY stremio_priority,priority,name'),'managed sources must have explicit deterministic source ordering');
assert(managed.includes('stremio_managed_accounts'),'managed runtime foundation must use a per-entitlement/server account mapping');
assert((managedEntitlements.match(/effective_stremio_entitlements/g)||[]).length>=2,'managed Stremio revoke and sync must use the Stremio effective entitlement view');
assert(!managedEntitlements.includes('effective_customer_entitlements'),'managed Stremio lifecycle must not use the media-server-only primary entitlement view');
assert(managedEntitlements.includes('effective_customer_addons'),'managed Stremio lifecycle must continue accepting add-on entitlements');
assert(managedEntitlements.includes('js.media_server_type'),'managed token cleanup must retain provider identity for logout');
assert(managedEntitlements.includes('logoutRestrictedToken({id:row.server_id,name:row.server_name,base_url:row.base_url,media_server_type:row.media_server_type}'),'managed disable cleanup must send provider identity to restricted-token logout');

// Source credential mutation is multi-instance state. Concurrent workers must
// serialize around the same provider identity and old credentials must become
// durable retired-token work before the current credential is overwritten.
assert(operationLock.includes('pg_try_advisory_lock(hashtextextended($1,0))'),'Stremio mutation lock must be a database advisory lock, not process-local state');
assert(operationLock.includes('pg_advisory_unlock(hashtextextended($1,0))'),'Stremio mutation lock must always have an explicit unlock path');
assert(tokenMaintenance.includes('operationLock.withLock(`external-token:${source.id}`'),'automatic external token rotation must serialize per source');
assert(tokenMaintenance.includes('SELECT * FROM stremio_sources WHERE id=$1 FOR UPDATE'),'token rotation must revalidate current source state in the mutation transaction');
assert(tokenMaintenance.includes('retireEncryptedTokenTx(db,locked'),'token rotation must durably retire the previous credential before replacing it');
assert(sourcePool.includes('operationLock.withLock(`external-token:${sourceId}`'),'manual reconnect/delete must share the same per-source serialization owner');
assert((sourcePool.match(/retireEncryptedTokenTx/g)||[]).length>=2,'manual reconnect and delete must durably retain the old token before losing source state');

// Hidden managed identities have the same external/local split. Creation must
// serialize per customer/server, and failed logout/disable must stay retryable
// instead of being mislabeled suspended and disappearing from reconciliation.
assert(managedEntitlements.includes('operationLock.withLock(`managed-account:${entitlement.customer_id}:${source.id}`'),'managed hidden-account creation/recovery must serialize per customer and media server');
assert(managedEntitlements.includes("SET status='error',last_error=$2"),'failed managed cleanup must retain durable error state');
assert(managedEntitlements.includes("sma.status IN('active','error')"),'managed cleanup reconciliation must retry prior error mappings');
assert(managedEntitlements.includes('if(!loggedOut)throw new Error'),'managed token replacement/suspension must fail closed when remote token revocation cannot be confirmed');
assert(managedEntitlements.includes("SET status='suspended',last_error=$2"),'managed mapping may become suspended only after remote cleanup succeeds');

assert(admin.includes("router.use('/admin/servers/stremio/managed',gate,noStore)"),'managed source compatibility route must stay authenticated and no-store');
assert(admin.includes("res.redirect(302,'/admin/servers/stremio')"),'old managed page must redirect to the single Stremio control centre');
assert(admin.includes('csrf.verify(req)'),'managed source mutation must retain CSRF protection');
assert(admin.includes('probeCredentials(server.base_url,key,type)'),'new API keys must be verified using the selected media-server provider');
assert(admin.includes("encryptWithEnv(key,'JELLYFIN_ENCRYPTION_KEY','jf1')"),'managed API keys must use the canonical media-server credential encryption purpose');
assert(admin.includes("'admin.stremio.managed_source.api_key.rotate'"),'managed API-key rotation must be audited without recording the key');
assert(admin.includes('mediaServerType:type'),'managed API-key rotation audit must record provider type');
assert(!admin.includes('decryptWithEnv')&&!admin.includes('decryptJellyfinKey'),'managed source handling must never decrypt an API key for display');
assert(admin.includes("res.redirect('/admin/servers/stremio?message='"),'managed source saves must return to the single Stremio page');

for(const phrase of ['Manage Stremio','Managed Jellyfin sources','External Jellyfin sources','Managed Stremio activity','Libraries included in Stremio'])assert(sources.includes(phrase),`single-page Stremio control centre missing: ${phrase}`);
assert(sources.indexOf('Managed Jellyfin sources')<sources.indexOf('External Jellyfin sources'),'managed server table must render before external sources');
assert(sources.indexOf('External Jellyfin sources')<sources.indexOf('${activitySection(d.activity)}'),'managed activity must follow both source groups');
assert(sources.includes("managedSources=require('../stremio/managed-sources')")&&sources.includes("managedMediaIndex=require('../stremio/media-index')"),'single page must load managed fleet and managed index state');
assert(sources.includes('capabilitySourceDisclosure')&&sources.includes('sourceInlineSettings'),'source maintenance must stay inline in the compact control centre');
assert(sources.includes('action="/admin/servers/stremio/managed/${esc(server.id)}"'),'managed rows must save through the canonical managed mutation route');
assert(sources.includes('action="/admin/servers/stremio/${esc(source.id)}/configure"'),'external sources must be configurable inline on the same page');
assert(sources.includes('name="enabled" value="1"')&&sources.includes('name="priority"'),'both source groups must expose participation and priority controls');
assert(sources.includes('External fallback playback goes directly to this Jellyfin server'),'external source UI must state that fallback playback bypasses CAPTAiNFiN media transport');
assert(/media bytes never pass through the portal/i.test(sources),'source UI must state the no-byte-proxy invariant');
assert(externalConfig.includes('UPDATE stremio_sources SET enabled=$2,priority=$3'),'external source participation and priority must update atomically');
assert(externalConfig.includes("'admin.stremio.source.configure'"),'external source inline configuration must be audited');
assert(!sources.includes('href="/admin/servers/stremio/${esc(source.id)}">Manage'),'main Stremio page must not expose a second external-management page');

assert(composition.includes('createAdminStremioManagedSourcesRouter'),'managed source mutation router must use canonical admin route composition');
assert(nav.includes("['stremio-sources','Stremio','/admin/servers/stremio']"),'Stremio product workspace must expose one canonical Stremio control centre');
assert(!nav.includes("['stremio-managed-sources','Managed Stremio'"),'Managed Stremio must not return as a second sidebar item');
assert(nav.includes("'stremio-managed-sources':'stremio-sources'"),'managed compatibility pages must still highlight the single Stremio sidebar entry');
assert(nav.includes('function sidebarKey(value){const key=activeKey(value)'),'navigation key resolver regression detected');
assert(!html.includes("require('./stremio-workflow-tabs')")&&!html.includes('stremioTabsFor'),'single Stremio control centre must not render obsolete top tabs');
assert(!fs.existsSync(path.join(root,'src/platform/stremio-workflow-tabs.js')),'obsolete Stremio workflow tabs module must remain removed');

console.log('stremio managed Jellyfin/Emby sources smoke: ok');
