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

assert(migration.includes('stremio_priority integer DEFAULT 100 NOT NULL'),'managed source priority migration missing');
assert(migration.includes('CREATE TABLE IF NOT EXISTS stremio_managed_accounts'),'multi-server managed-account mapping missing');
assert(migration.includes('UNIQUE(entitlement_id, server_id)'),'managed account must be unique per entitlement/server');
assert(migration.includes('jellyfin_access_token_encrypted'),'legacy managed entitlement migration must preserve restricted playback tokens');
assert(managed.includes("registry.request(serverId,'/System/Info/Public'"),'managed source enablement must validate the stored backend Jellyfin credential');
assert(managed.includes('public_url IS NOT NULL'),'managed direct playback sources must require a public URL');
assert(managed.includes('ORDER BY stremio_priority,priority,name'),'managed sources must have explicit deterministic source ordering');
assert(managed.includes('stremio_managed_accounts'),'managed runtime foundation must use a per-entitlement/server account mapping');
assert(admin.includes("router.use('/admin/servers/stremio/managed',gate,noStore)"),'managed source admin route must be authenticated and no-store');
assert(admin.includes('csrf.verify(req)'),'managed source mutation must retain CSRF protection');
assert(admin.includes('server API key is never embedded'),'admin UI must explain the API credential boundary');
assert(!admin.includes('api_key_encrypted'),'admin page must never render encrypted API credential storage');
assert(composition.includes('createAdminStremioManagedSourcesRouter'),'managed source router must use canonical admin route composition');
assert(nav.includes("['stremio-managed-sources','Managed Stremio','/admin/servers/stremio/managed']"),'managed source controls must be reachable from admin navigation');
assert(nav.includes('function sidebarKey(value){const key=activeKey(value)'),'navigation key resolver regression detected');

console.log('stremio managed sources smoke: ok');
