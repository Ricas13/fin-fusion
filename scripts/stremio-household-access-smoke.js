'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
function read(file){return fs.readFileSync(path.join(root,file),'utf8');}

const runtime=read('src/stremio/runtime.js');
const managedRuntime=read('src/stremio/managed-runtime.js');
const lifecycle=read('src/stremio/managed-playback-lifecycle.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourcePool=read('src/stremio/source-pool.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const plansList=read('src/platform/admin-plans-list.js');
const storefront=read('src/platform/storefront-core.js');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const customerDashboard=read('views/customer/dashboard.ejs');
const jobs=read('src/automation/jobs.js');

assert(!runtime.includes("require('./source-admission')"),'runtime must not depend on Stremio commercial source admission');
assert(!runtime.includes('managed-session-reconciler'),'runtime must not start the retired Stremio session-limit reconciler');
assert(!runtime.includes("reason:'stream_limit'")&&!runtime.includes("reason: 'stream_limit'"),'runtime must not emit commercial Stremio stream-limit 429s');
assert(!runtime.includes('X-CAPTAiNFiN-Stream-Active')&&!runtime.includes('X-CAPTAiNFiN-Stream-Limit'),'runtime must not expose retired Stremio stream-count headers');
assert((runtime.match(/reason:'protocol_rate_limit'/g)||[]).length>=3,'install-token protocol rate limits must remain enabled');
assert(runtime.includes('managedPlayback.startManager({intervalMs:5000})'),'managed playback cleanup manager must remain active');
assert(runtime.includes('managedPlayback.start(mapping,playbackKey'),'managed control path must track per-playback Jellyfin lifecycle state');
assert(runtime.includes('res.redirect(307,target.url)'),'managed playback must end in a Jellyfin redirect');
assert(runtime.includes('media bytes never pass through CAPTAiNFiN'),'managed playback contract must explicitly remain control-plane only');

assert(!managedRuntime.includes("require('./source-admission')"),'managed stream discovery must not depend on commercial admission');
assert(managedRuntime.includes('managedPlayback.issuePlaybackKey()'),'managed stream discovery must mint an opaque playback lifecycle key');
assert(managedRuntime.includes('playbackKey'),'managed stream URL must carry the playback lifecycle key');
assert(!managedRuntime.includes('sourceAdmission.issue'),'managed stream discovery must not issue commercial stream leases');

assert(!lifecycle.includes("require('./source-admission')"),'managed lifecycle must not depend on commercial admission');
assert(!lifecycle.includes('stream_limit'),'managed lifecycle must not inspect a Stremio stream limit');
assert(lifecycle.includes('TRACKING_SECONDS=20'),'managed lifecycle must keep short-lived cleanup tracking');
assert(lifecycle.includes("'/Sessions/Playing'"),'managed lifecycle must still register Jellyfin playback');
assert(lifecycle.includes("'/Sessions/Playing/Stopped'"),'managed lifecycle must still report Jellyfin playback stop');
assert(lifecycle.includes("'/Sessions/Logout'"),'managed lifecycle must still revoke its per-playback Jellyfin credential');
assert(lifecycle.includes("if(!session&&started&&now-started<START_GRACE_SECONDS*1000)continue"),'startup grace must apply whenever the new Jellyfin session is not visible yet');

assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden Stremio Jellyfin identities must remain unlimited at Jellyfin account policy level');
assert(!managedEntitlements.includes('entitlements.streamLimit'),'managed Stremio identity policy must not derive from plan stream count');

const hiddenScope=(jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length;
assert(hiddenScope>=2,'generic Jellyfin activity monitoring and revalidation must both exclude stremio_internal identities');

assert(planCreate.includes("streams=serviceType==='stremio'?1:int(body.streams,1,50,'Jellyfin concurrent streams')"),'Stremio-only plan creation must treat streams as a compatibility value, not a commercial Stremio allowance');
assert(planCreate.includes('1 Stremio household per subscription'),'plan creation UI must explain household access');
assert(plansList.includes("if(type==='stremio')return'1 Stremio household'"),'admin plan list must describe Stremio as household access');
assert(plansList.includes('Jellyfin stream${streams===1?\'\':\'s\'} · 1 Stremio household'),'bundle plan list must separate Jellyfin streams from Stremio household access');
assert(storefront.includes("if(type==='stremio')return'1 Stremio household'"),'storefront must describe Stremio as household access');
assert(stremioDashboard.includes('Stremio household'),'Stremio customer dashboard must show household access');
assert(stremioDashboard.includes('no concurrent-stream limit'),'Stremio customer dashboard must not imply a plan stream cap');
assert(customerDashboard.includes('Jellyfin streams'),'bundle/Jellyfin dashboard must label its stream count as Jellyfin-only');
assert(customerDashboard.includes('1 Stremio household is included separately from your Jellyfin stream allowance'),'bundle dashboard must describe Stremio household separately');

assert(!sourcePool.includes("const http=require('http')")&&!sourcePool.includes('openPlayback('),'external source pool must not contain the retired byte relay');
assert(!sourcePool.includes('/stremio/${encodeURIComponent(installToken)}/source/'),'external source pool must not construct CAPTAiNFiN media proxy URLs');
assert(!jobs.includes('source-admission'),'automation jobs must not maintain retired commercial Stremio admission leases');

for(const retired of ['src/stremio/source-admission.js','src/stremio/managed-session-reconciler.js','src/stremio/source-capability.js','src/stremio/source-playback.js']){
  assert(!fs.existsSync(path.join(root,retired)),`${retired} must be removed`);
}

console.log('stremio household access smoke: ok');
