'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/016_stremio_managed_source_foundation.sql');
const managed=read('src/stremio/managed-sources.js');
const admin=read('src/platform/admin-stremio-managed-sources.js');
const composition=read('src/platform/admin-route-composition.js');
const nav=read('src/platform/admin-nav.js');
const html=read('src/platform/admin-html.js');
const tabs=read('src/platform/stremio-workflow-tabs.js');

assert(migration.includes('stremio_priority integer DEFAULT 100 NOT NULL'),'managed source priority migration missing');
assert(migration.includes('CREATE TABLE IF NOT EXISTS stremio_managed_accounts'),'multi-server managed-account mapping missing');
assert(migration.includes('UNIQUE(entitlement_id, server_id)'),'managed account must be unique per entitlement/server');
assert(migration.includes('jellyfin_access_token_encrypted'),'legacy managed entitlement migration must preserve restricted playback tokens');
assert(managed.includes("registry.request(serverId,'/System/Info/Public'"),'managed source enablement must validate the stored backend Jellyfin credential');
assert(managed.includes('api_configured'),'managed source view may expose credential presence but not its value');
assert(managed.includes('public_url IS NOT NULL'),'managed direct playback sources must require a public URL');
assert(managed.includes('ORDER BY stremio_priority,priority,name'),'managed sources must have explicit deterministic source ordering');
assert(managed.includes('stremio_managed_accounts'),'managed runtime foundation must use a per-entitlement/server account mapping');
assert(admin.includes("router.use('/admin/servers/stremio/managed',gate,noStore)"),'managed source admin route must be authenticated and no-store');
assert(admin.includes('csrf.verify(req)'),'managed source mutation must retain CSRF protection');
assert(admin.includes('type="password" name="apiKey"'),'managed source page must allow write-only Jellyfin API-key entry');
assert(admin.includes('autocomplete="new-password"'),'managed API key field must not be treated as a readable saved credential');
assert(admin.includes('probeCredentials(server.base_url,key)'),'new API keys must be verified against Jellyfin before storage');
assert(admin.includes("encryptWithEnv(key,'JELLYFIN_ENCRYPTION_KEY','jf1')"),'managed API keys must use the canonical Jellyfin encryption purpose');
assert(admin.includes("'admin.stremio.managed_source.api_key.rotate'"),'managed API-key rotation must be audited without recording the key');
assert(!admin.includes('decryptWithEnv')&&!admin.includes('decryptJellyfinKey'),'managed source UI must never decrypt an API key for display');
assert(admin.includes('Write-only. Leave blank to keep the current key'),'managed source UI must explain the API credential boundary without exposing the key');
assert(admin.includes('<details class="managedCredential">'),'rarely changed API-key controls must be collapsed behind a compact disclosure');
assert(admin.includes('managedControls')&&admin.includes('managedPriority')&&admin.includes('managedActions'),'managed controls must use the compact row layout');
assert(composition.includes('createAdminStremioManagedSourcesRouter'),'managed source router must use canonical admin route composition');
assert(nav.includes("['stremio-sources','Stremio','/admin/servers/stremio/managed']"),'Stremio sidebar entry must land on Manage Stremio');
assert(!nav.includes("['stremio-managed-sources','Managed Stremio','/admin/servers/stremio/managed']"),'Managed Stremio must not remain as a second sidebar item');
assert(nav.includes("'stremio-managed-sources':'stremio-sources'"),'managed Stremio page must still highlight the single Stremio sidebar entry');
assert(nav.includes('function sidebarKey(value){const key=activeKey(value)'),'navigation key resolver regression detected');
assert(tabs.includes("['manage','Manage Stremio','/admin/servers/stremio/managed']"),'Stremio workflow must expose Manage Stremio as a top tab');
assert(tabs.includes("['external','External Sources','/admin/servers/stremio']"),'Stremio workflow must retain external source management as a top tab');
assert(html.includes("if(active==='stremio-managed-sources')return stremioWorkflow.tabs('manage')"),'managed Stremio page must render the top workflow tabs');
assert(html.includes("if(active==='stremio-sources')return stremioWorkflow.tabs('external')"),'external Stremio pages must render the same top workflow tabs');

console.log('stremio managed sources smoke: ok');
