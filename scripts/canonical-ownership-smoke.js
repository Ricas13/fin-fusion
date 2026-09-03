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

// Authentication: one public facade owns explicit step-up semantics. The old
// service-core compatibility path is intentionally gone now that nothing calls it.
assert(!fs.existsSync(path.join(root,'src/auth/service-core.js')),'retired auth compatibility facade must stay removed');
const auth=read('src/auth/service.js');
assert(auth.includes("require('./service-engine')"),'canonical auth service must use the internal engine');
assert(!auth.includes("require('./service-core')"),'canonical auth service must not depend on its historical alias');
assert(auth.includes('pendingStaffAuth=prior||{stepUp:true'),'canonical auth service must preserve explicit step-up enforcement');
assert.deepStrictEqual(importers("require('./service-engine')"),['src/auth/service.js'],'only the canonical auth facade may import service-engine');

// Admin security: only the canonical facade may compose step-up and mutation guards.
assert(!fs.existsSync(path.join(root,'src/platform/admin-security-core.js')),'retired admin-security compatibility facade must stay removed');
const adminSecurity=read('src/platform/admin-security.js');
assert(adminSecurity.includes("require('./admin-security-routes')"),'canonical admin security facade must use internal routes');
assert(adminSecurity.includes('createAdminStepUpRouter')&&adminSecurity.includes('sensitiveMutationGuard'),'canonical admin security facade must retain step-up and sensitive mutation guards');
assert.deepStrictEqual(importers("require('./admin-security-routes')"),['src/platform/admin-security.js'],'only the canonical admin security facade may import internal security routes');

// Jellyfin provisioning: low-level helpers are dependency-safe, the legacy
// facade delegates every customer mutation, and the resilient owner never imports
// the compatibility facade. This keeps old callers working without a module cycle
// or a path back into the retired single-lane mutation implementation.
assert(!fs.existsSync(path.join(root,'src/jellyfin/provisioning-core.js')),'retired provisioning compatibility facade must stay removed');
const provisioning=read('src/jellyfin/provisioning.js');
const provisioningHelpers=read('src/jellyfin/provisioning-helpers.js');
const provisioningEngine=read('src/jellyfin/provisioning-engine.js');
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const subscriptionExpiry=read('src/entitlements/subscription-expiry.js');
assert(provisioningHelpers.includes("require('./provisioning-engine')"),'dependency-safe helper surface must own the internal engine import');
assert(provisioning.includes("require('./provisioning-helpers')"),'compatibility facade must consume the dependency-safe helper surface');
assert(resilientProvisioning.includes("require('./provisioning-helpers')"),'canonical reconciler must consume helpers directly');
assert(!resilientProvisioning.includes("require('./provisioning')"),'canonical reconciler must never depend on the compatibility facade');
assert(!provisioning.includes("require('./provisioning-engine')"),'compatibility facade must not import the internal engine directly');
assert.deepStrictEqual(importers("require('./provisioning-engine')"),['src/jellyfin/provisioning-helpers.js'],'only the dependency-safe helper module may import provisioning-engine');
assert(provisioningHelpers.includes('markPasswordSetupRequired'),'helper surface must retain password-setup state for created Jellyfin identities');
for(const retired of ['reconcileCustomer','reconcileAccount','holdAccess','releaseAccess','expireSubscriptionsAndReconcile']){
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningHelpers.split('module.exports =')[1]||''),`helper surface must never export retired mutation ${retired}`);
  assert(!new RegExp(`async function\\s+${retired}\\b`).test(provisioningEngine),`low-level provisioning engine must not retain retired mutation implementation ${retired}`);
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningEngine.split('module.exports =')[1]||''),`low-level provisioning engine must never export retired mutation ${retired}`);
}
for(const retired of ['selectServerForPlan','currentEntitlement']){
  assert(!new RegExp(`async function\\s+${retired}\\b`).test(provisioningEngine),`low-level provisioning engine must not retain canonical ownership helper ${retired}`);
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningEngine.split('module.exports =')[1]||''),`low-level provisioning engine must not export canonical ownership helper ${retired}`);
}
assert(!provisioningEngine.includes("require('./placement')")&&!provisioningEngine.includes("require('../entitlements/subscription-state')"),'primitive provisioning engine must not regain placement or entitlement dependencies');
assert(provisioning.includes("function canonicalReconciler() { return require('./resilient-provisioning'); }"),'legacy provisioning imports must route mutations through the resilient multi-lane owner');
assert(provisioning.includes('canonicalReconciler().reconcileCustomer(customerId)')&&provisioning.includes('canonicalReconciler().reconcileAccount(accountId)'),'customer and account reconciliation must delegate to resilient provisioning');
assert(provisioning.includes('canonicalReconciler().holdAccess(customerId, reason, actorUserId)')&&provisioning.includes('canonicalReconciler().releaseAccess(customerId, actorUserId)'),'access-hold mutations must delegate to the same canonical owner');
assert(provisioning.includes('canonicalReconciler().expireSubscriptionsAndReconcile()'),'subscription expiry compatibility path must delegate to the canonical owner');
assert(resilientProvisioning.includes('inactivityHoldReconciliation.releaseObsoleteForCustomer'),'canonical resilient provisioning must retain inactivity-hold reconciliation');
assert(resilientProvisioning.includes('autoDowngradeEligibleCustomer'),'canonical resilient provisioning must retain automatic free-tier downgrade behavior');
assert(provisioning.includes("require('../entitlements/subscription-expiry')")&&resilientProvisioning.includes("require('../entitlements/subscription-expiry')"),'notification compatibility and canonical mutation owner must both use the entitlement expiry helper');
assert(!provisioning.includes('subscriptionExpiry.expireAndReconcile'),'compatibility facade must not own an independent expiry/reconcile callback');
assert(resilientProvisioning.includes('subscriptionExpiry.expireAndReconcile'),'canonical reconciler must own expiry/reconcile composition');
assert(!provisioning.includes('WITH expired AS')&&!resilientProvisioning.includes('WITH expired AS'),'subscription expiry SQL must not be duplicated across provisioning layers');
assert(subscriptionExpiry.includes('WITH expired AS')&&subscriptionExpiry.includes("status IN('active','trialing','past_due','paused','cancelled')"),'canonical subscription expiry helper must own the expiry state transition');
assert.deepStrictEqual(importers("require('../entitlements/subscription-expiry')"),['src/jellyfin/provisioning.js','src/jellyfin/resilient-provisioning.js'],'subscription expiry helper consumers must stay limited to provisioning surfaces');

// Database schema ownership: migrations create the session table; web runtime only uses it.
const application=read('src/application.js');
const sessionMigration=read('db/migrations/002_add_runtime_session_store.sql');
assert(sessionMigration.includes('CREATE TABLE IF NOT EXISTS user_sessions'),'session table must remain migration-owned');
assert(/createTableIfMissing:\s*false/.test(application),'web session store must rely on migrated user_sessions');
assert(!/createTableIfMissing:\s*true/.test(application),'web runtime must never regain session-table DDL fallback');

// Stremio ownership: household access remains a control-plane contract while
// the stream resource hands Stremio the dedicated restricted media-server user's
// static/original media URL directly. No CAPTAiNFiN media relay or provider
// playback-session lifecycle is allowed in that path.
const external=read('src/stremio/external-direct-runtime.js');
const managed=read('src/stremio/managed-runtime.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const stremioRuntime=read('src/stremio/runtime.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
assert(!external.includes('controlPlaybackUrl')&&external.includes('directPlaybackUrl(')&&/url\.searchParams\.set\(\s*['"]Static['"]\s*,\s*['"]true['"]\s*\)/.test(external)&&external.includes("url.searchParams.set('api_key',client.sourceToken(source))")&&external.includes('source.media_server_type'),'external playback must return its dedicated media-server user raw-file URL directly through the stored provider');
assert(managed.includes("url.searchParams.set('Static','true')")&&managed.includes("url.searchParams.set('api_key',token)"),'managed playback must return its restricted hidden media-server user raw-file URL directly');
assert(!managed.includes('/PlaybackInfo')&&!stremioRuntime.includes("require('./managed-playback-lifecycle')"),'managed Stremio delivery must not negotiate or report a media-server playback session');
assert(stremioRuntime.includes("householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' })"),'direct stream results must claim household access before authenticated media-server URLs leave CAPTAiNFiN');
assert(!external.includes('pipe(res)')&&!stremioRuntime.includes('pipe(res)'),'Stremio media bytes must never be relayed through CAPTAiNFiN');
assert(stremioEntitlements.includes('persistEntitlementRecord')&&stremioEntitlements.includes('managedAccountOwned'),'install-link reconciliation must not own or reset the managed hidden-user identity');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden managed media-server users must remain unlimited at provider session-policy level');
assert(!fs.existsSync(path.join(root,'src/stremio/source-admission.js')),'retired Stremio commercial admission module must remain absent');
assert(!stremioRuntime.includes('stream_limit')&&!stremioRuntime.includes("require('./source-admission')"),'Stremio protocol runtime must not enforce a commercial concurrent-stream quota');
assert(stremioRuntime.includes("'/stremio/:token/play/:mappingId/:itemId/:mediaSourceId'")&&stremioRuntime.includes('managedRuntime.directUrl(mapping, req.params.itemId, req.params.mediaSourceId)'),'legacy managed control links must remain compatibility-only and resolve to raw media-server delivery');
assert(stremioRuntime.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'")&&stremioRuntime.includes('playbackTargetFor(entitlement, req.params.sourceId, req.params.itemId, req.params.mediaSourceId)'),'legacy external control links must remain compatibility-only');
assert(/router\.get\('\/stremio\/:token\/source\/:sourceId\/:itemId\/:mediaSourceId'\s*,[\s\S]{0,120}\bretiredPlayback\s*\)/.test(stremioRuntime)&&stremioRuntime.includes("const retiredPlayback = (_req, res) => res.status(410).end()"),'legacy external proxy URLs must remain retired with 410 semantics regardless of optional route middleware');
assert((jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length>=2,'ordinary media concurrency monitoring must exclude hidden Stremio identities');

console.log('canonical ownership smoke: ok');
