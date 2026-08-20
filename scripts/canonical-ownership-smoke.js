'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

function jsFiles(dir){
  const rows=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())rows.push(...jsFiles(full));
    else if(entry.isFile()&&entry.name.endsWith('.js'))rows.push(full);
  }
  return rows;
}
function relative(file){return path.relative(root,file).replace(/\\/g,'/');}
function importers(fragment){return jsFiles(path.join(root,'src')).filter(file=>read(relative(file)).includes(fragment)).map(relative).sort();}
function alias(file,target){
  const source=read(file);
  assert.match(source,new RegExp(`module\\.exports\\s*=\\s*require\\(['\"]${target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}['\"]\\)`),`${file} must delegate to ${target}`);
  assert(!/\basync\s+function\b/.test(source),`${file} must not contain a second implementation`);
}

// Authentication: one public facade owns explicit step-up semantics.
alias('src/auth/service-core.js','./service');
const auth=read('src/auth/service.js');
assert(auth.includes("require('./service-engine')"),'canonical auth service must use the internal engine');
assert(!auth.includes("require('./service-core')"),'canonical auth service must not depend on its historical alias');
assert(auth.includes('pendingStaffAuth=prior||{stepUp:true'),'canonical auth service must preserve explicit step-up enforcement');
assert.deepStrictEqual(importers("require('./service-engine')"),['src/auth/service.js'],'only the canonical auth facade may import service-engine');

// Admin security: only the canonical facade may compose step-up and mutation guards.
alias('src/platform/admin-security-core.js','./admin-security');
const adminSecurity=read('src/platform/admin-security.js');
assert(adminSecurity.includes("require('./admin-security-routes')"),'canonical admin security facade must use internal routes');
assert(adminSecurity.includes('createAdminStepUpRouter')&&adminSecurity.includes('sensitiveMutationGuard'),'canonical admin security facade must retain step-up and sensitive mutation guards');
assert.deepStrictEqual(importers("require('./admin-security-routes')"),['src/platform/admin-security.js'],'only the canonical admin security facade may import internal security routes');

// Jellyfin provisioning: all public calls pass through the entitlement/lifecycle facade.
alias('src/jellyfin/provisioning-core.js','./provisioning');
const provisioning=read('src/jellyfin/provisioning.js');
assert(provisioning.includes("require('./provisioning-engine')"),'canonical provisioning facade must use internal engine');
assert(!provisioning.includes("require('./provisioning-core')"),'canonical provisioning facade must not depend on its historical alias');
assert(provisioning.includes('inactivityHoldReconciliation.releaseObsoleteForCustomer'),'canonical provisioning must retain inactivity-hold reconciliation');
assert(provisioning.includes('markPasswordSetupRequired'),'canonical provisioning must retain password-setup state');
assert(provisioning.includes('maybeAutoDowngrade'),'canonical provisioning must retain automatic free-tier downgrade behavior');
assert.deepStrictEqual(importers("require('./provisioning-engine')"),['src/jellyfin/provisioning.js'],'only the canonical provisioning facade may import provisioning-engine');

// Database schema ownership: migrations create the session table; web runtime only uses it.
const application=read('src/application.js');
const sessionMigration=read('db/migrations/002_add_runtime_session_store.sql');
assert(sessionMigration.includes('CREATE TABLE IF NOT EXISTS user_sessions'),'session table must remain migration-owned');
assert(/createTableIfMissing:\s*false/.test(application),'web session store must rely on migrated user_sessions');
assert(!/createTableIfMissing:\s*true/.test(application),'web runtime must never regain session-table DDL fallback');

// Lock the critical Delivery audit fixes that are already present on main.
const external=read('src/stremio/external-direct-runtime.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourceAdmission=read('src/stremio/source-admission.js');
assert(external.includes('admissionUrl(')&&external.includes('/source/${encodeURIComponent(String(source.id))}'),'external Stremio results must enter CAPTAiNFiN admission');
assert(!external.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'external Stremio result URLs must never expose the stored Jellyfin source token');
assert(stremioEntitlements.includes('persistEntitlementRecord')&&stremioEntitlements.includes('managedAccountOwned'),'install-link reconciliation must not own or reset the managed hidden-user identity');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden managed Jellyfin users must leave session counting to CAPTAiNFiN');
assert(sourceAdmission.includes('if(active>=limit)return{allowed:false,reason:\'stream_limit\''),'CAPTAiNFiN admission must enforce the entitlement stream limit');

console.log('canonical ownership smoke: ok');
