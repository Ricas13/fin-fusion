'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/016_stremio_managed_source_foundation.sql');
const managed=read('src/stremio/managed-sources.js');
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
assert(managed.includes("registry.request(serverId,'/System/Info/Public'"),'managed source enablement must validate the stored backend Jellyfin credential');
assert(managed.includes('api_configured'),'managed source view may expose credential presence but not its value');
assert(managed.includes('public_url IS NOT NULL'),'managed direct playback sources must require a public URL');
assert(managed.includes('ORDER BY stremio_priority,priority,name'),'managed sources must have explicit deterministic source ordering');
assert(managed.includes('stremio_managed_accounts'),'managed runtime foundation must use a per-entitlement/server account mapping');

assert(admin.includes("router.use('/admin/servers/stremio/managed',gate,noStore)"),'managed source compatibility route must stay authenticated and no-store');
assert(admin.includes("res.redirect(302,'/admin/servers/stremio')"),'old managed page must redirect to the single Stremio control centre');
assert(admin.includes('csrf.verify(req)'),'managed source mutation must retain CSRF protection');
assert(admin.includes('probeCredentials(server.base_url,key)'),'new API keys must be verified against Jellyfin before storage');
assert(admin.includes("encryptWithEnv(key,'JELLYFIN_ENCRYPTION_KEY','jf1')"),'managed API keys must use the canonical Jellyfin encryption purpose');
assert(admin.includes("'admin.stremio.managed_source.api_key.rotate'"),'managed API-key rotation must be audited without recording the key');
assert(!admin.includes('decryptWithEnv')&&!admin.includes('decryptJellyfinKey'),'managed source handling must never decrypt an API key for display');
assert(admin.includes("res.redirect('/admin/servers/stremio?message='"),'managed source saves must return to the single Stremio page');

for(const phrase of ['Your Jellyfin servers','External Jellyfin servers','Recent connection attempts','One private Stremio source pool'])assert(sources.includes(phrase),`single-page Stremio control centre missing: ${phrase}`);
assert(sources.indexOf('Your Jellyfin servers')<sources.indexOf('External Jellyfin servers'),'managed server table must render before external sources');
assert(sources.indexOf('External Jellyfin servers')<sources.indexOf('Recent connection attempts'),'connection history must follow both source tables');
assert(sources.includes("managedSources=require('../stremio/managed-sources')")&&sources.includes("managedMediaIndex=require('../stremio/media-index')"),'single page must load managed fleet and managed index state');
assert(sources.includes('action="/admin/servers/stremio/managed/${esc(server.id)}"'),'managed rows must save through the canonical managed mutation route');
assert(sources.includes('type="password" name="apiKey"'),'single Stremio page must retain write-only managed API-key entry');
assert(sources.includes('autocomplete="new-password"'),'managed API key field must not be treated as a readable saved credential');
assert(sources.includes('Managed results always appear before external results'),'admin UI must explain managed-first ordering');
assert(sources.includes('External Jellyfin servers')&&sources.includes('action="/admin/servers/stremio/${esc(source.id)}/configure"'),'external sources must be configurable inline on the same page');
assert(sources.includes('name="enabled" value="1"')&&sources.includes('name="priority"'),'both source groups must expose participation and priority controls');
assert(externalConfig.includes('UPDATE stremio_sources SET enabled=$2,priority=$3'),'external source participation and priority must update atomically');
assert(externalConfig.includes("'admin.stremio.source.configure'"),'external source inline configuration must be audited');
assert(sources.includes('sourceInlineManage')&&sources.includes('sourceManageGrid'),'external source maintenance must expand inline rather than requiring navigation away');
assert(sources.includes('name="returnTo" value="main"'),'inline external maintenance must return to the single control centre');
assert(!sources.includes('href="/admin/servers/stremio/${esc(source.id)}">Manage'),'main Stremio page must not expose a second external-management page');

assert(composition.includes('createAdminStremioManagedSourcesRouter'),'managed source mutation router must use canonical admin route composition');
assert(nav.includes("['stremio-sources','Sources','/admin/servers/stremio']"),'Stremio product workspace must expose Sources as the canonical source control centre');
assert(!nav.includes("['stremio-managed-sources','Managed Stremio'"),'Managed Stremio must not return as a second sidebar item');
assert(nav.includes("'stremio-managed-sources':'stremio-sources'"),'managed compatibility pages must still highlight the single Stremio sidebar entry');
assert(nav.includes('function sidebarKey(value){const key=activeKey(value)'),'navigation key resolver regression detected');
assert(!html.includes("require('./stremio-workflow-tabs')")&&!html.includes('stremioTabsFor'),'single Stremio control centre must not render obsolete top tabs');
assert(!fs.existsSync(path.join(root,'src/platform/stremio-workflow-tabs.js')),'obsolete Stremio workflow tabs module must remain removed');

console.log('stremio managed sources smoke: ok');
