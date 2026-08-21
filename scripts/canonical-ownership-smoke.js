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
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const subscriptionExpiry=read('src/entitlements/subscription-expiry.js');
assert(provisioning.includes("require('./provisioning-engine')"),'canonical provisioning facade must use internal engine');
assert(!provisioning.includes("require('./provisioning-core')"),'canonical provisioning facade must not depend on its historical alias');
assert(provisioning.includes('inactivityHoldReconciliation.releaseObsoleteForCustomer'),'canonical provisioning must retain inactivity-hold reconciliation');
assert(provisioning.includes('markPasswordSetupRequired'),'canonical provisioning must retain password-setup state');
assert(provisioning.includes('maybeAutoDowngrade'),'canonical provisioning must retain automatic free-tier downgrade behavior');
assert.deepStrictEqual(importers("require('./provisioning-engine')"),['src/jellyfin/provisioning.js'],'only the canonical provisioning facade may import provisioning-engine');
assert(provisioning.includes("require('../entitlements/subscription-expiry')")&&resilientProvisioning.includes("require('../entitlements/subscription-expiry')"),'both provisioning facades must delegate expiry selection to the canonical entitlement helper');
assert(provisioning.includes('subscriptionExpiry.expireAndReconcile')&&resilientProvisioning.includes('subscriptionExpiry.expireAndReconcile'),'provisioning facades must retain their own reconcile callbacks while sharing expiry ownership');
assert(!provisioning.includes('WITH expired AS')&&!resilientProvisioning.includes('WITH expired AS'),'subscription expiry SQL must not be duplicated across provisioning layers');
assert(subscriptionExpiry.includes('WITH expired AS')&&subscriptionExpiry.includes("status IN('active','trialing','past_due','paused','cancelled')"),'canonical subscription expiry helper must own the expiry state transition');
assert.deepStrictEqual(importers("require('../entitlements/subscription-expiry')"),['src/jellyfin/provisioning.js','src/jellyfin/resilient-provisioning.js'],'subscription expiry helper consumers must stay limited to provisioning facades');

// Database schema ownership: migrations create the session table; web runtime only uses it.
const application=read('src/application.js');
const sessionMigration=read('db/migrations/002_add_runtime_session_store.sql');
assert(sessionMigration.includes('CREATE TABLE IF NOT EXISTS user_sessions'),'session table must remain migration-owned');
assert(/createTableIfMissing:\s*false/.test(application),'web session store must rely on migrated user_sessions');
assert(!/createTableIfMissing:\s*true/.test(application),'web runtime must never regain session-table DDL fallback');

// Stremio ownership: household access is a control-plane contract, not a
// commercial per-stream admission system or a media relay. External stream
// cards now take one household-aware playback-start hop before resolving to the
// dedicated Jellyfin user's direct URL.
const external=read('src/stremio/external-direct-runtime.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const stremioRuntime=read('src/stremio/runtime.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
assert(external.includes('/external-play/')&&external.includes('playbackTargetFor')&&external.includes('directPlaybackUrl(')&&external.includes("url.searchParams.set('api_key', client.sourceToken(source))"),'external playback must take one household control hop then resolve to its dedicated Jellyfin user');
assert(!external.includes('pipe(res)')&&!stremioRuntime.includes('pipe(res)'),'Stremio media bytes must never be relayed through CAPTAiNFiN');
assert(stremioEntitlements.includes('persistEntitlementRecord')&&stremioEntitlements.includes('managedAccountOwned'),'install-link reconciliation must not own or reset the managed hidden-user identity');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden managed Jellyfin users must remain unlimited at Jellyfin session-policy level');
assert(!fs.existsSync(path.join(root,'src/stremio/source-admission.js')),'retired Stremio commercial admission module must remain absent');
assert(!stremioRuntime.includes('stream_limit')&&!stremioRuntime.includes("require('./source-admission')"),'Stremio protocol runtime must not enforce a commercial concurrent-stream quota');
assert(stremioRuntime.includes('const PLAYBACK_REDIRECT_STATUS = 302')&&stremioRuntime.includes('return res.redirect(PLAYBACK_REDIRECT_STATUS, target.url)'),'managed Stremio playback must leave the portal through a plain temporary Jellyfin redirect');
assert(stremioRuntime.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'")&&stremioRuntime.includes('return res.redirect(PLAYBACK_REDIRECT_STATUS, target)'),'external Stremio playback must leave the portal through its household-aware temporary Jellyfin redirect');
assert(stremioRuntime.includes("router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId', playbackLimit, retiredPlayback)"),'legacy external proxy URLs must remain retired');
assert((jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length>=2,'ordinary Jellyfin concurrency monitoring must exclude hidden Stremio identities');

console.log('canonical ownership smoke: ok');
