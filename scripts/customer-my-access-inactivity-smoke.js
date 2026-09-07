'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const {freeAccessHealth}=require('../src/platform/customer-jellyfin');

const route=read('src/platform/customer-jellyfin.js');
const view=read('views/customer/jellyfin.ejs');
const stremioRoute=read('src/platform/customer-stremio.js');
const client=read('public/js/customer-jellyfin.js');

assert.match(route,/jellyfin-cleanup-return/,'My Access must consult the canonical returning-customer inactivity state');
assert.match(route,/cleanupReturn\.returningCustomerStatus\(customerId\)/,'My Access must resolve intentional inactivity removal before rendering subscriptions');
assert.match(route,/function markRemovedFreeAccess\(/,'My Access must decorate retained Free Server entitlements that were intentionally removed');
assert.match(route,/access_removed:true,access_removed_reason:'inactivity'/,'inactivity-removed Free Server access must carry an explicit non-active presentation state');
assert.match(route,/const subscriptions=markRemovedFreeAccess\(rawSubscriptions,returnStatus\)/,'the decorated subscription state must be the state rendered by My Access');
assert.match(route,/returnStatus,/,'the view must receive restoration state for the removed Free Server profile');

assert.match(view,/activeSubscriptions=accessRows\.filter\(subscription=>!subscription\.access_removed\)/,'active access must exclude intentionally removed subscriptions');
assert.match(view,/removedSubscriptions=accessRows\.filter\(subscription=>subscription\.access_removed\)/,'removed access must be rendered separately');
assert.match(view,/Removed for inactivity/,'removed Free Server access must never be labelled Active');
assert.match(view,/Free Server access removed for inactivity/,'My Access must explain why Free Server access ended');
assert.match(view,/It is not active and is not waiting for normal provisioning/,'intentional inactivity removal must not be presented as a provisioning failure');
assert.match(view,/Restore Free Server access/,'a retained Free Server entitlement must offer explicit restoration');
assert.match(view,/method="post" action="\/account\/provisioning\/retry"/,'restoration must reuse the existing guarded provisioning retry mutation');
assert.match(view,/if\(!accounts\.length&&hasPendingMediaAccess\)/,'generic provisioning UI must only appear when current active media access is genuinely missing an account');
assert.match(view,/hasPendingMediaAccess=activeSubscriptions\.some/,'removed Free Server access must not make generic provisioning appear pending');

assert.match(view,/class="freeWatchLabel">Watch status</,'Free Server access must keep the compact watch-status treatment');
assert.match(view,/Meeting usage rules/,'Free Server watch status must explain whether usage rules are being met');
assert.match(view,/Current <%= Number\(freeHealth\.playbackWindowDays\)\|\|7 %>-day window/,'Free Server watch status must show the current playback window');
assert.match(route,/const observation=asDate\(status\.observationStartedAt\),inactiveReference=asDate\(status\.inactiveReferenceAt\)/,'My Access deadlines must consume the exact observation/reference boundaries returned by the enforcement evaluator');
const reentryHealth=freeAccessHealth({
  applies:true,
  policy:{noPlaybackDays:4,minimumPlaybackMinutes:null,playbackWindowDays:7,minimumObservationHours:24},
  observationStartedAt:'2026-09-05T12:00:00.000Z',
  inactiveReferenceAt:'2026-09-05T12:00:00.000Z',
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(reentryHealth.removalAt.toISOString(),'2026-09-09T12:00:00.000Z','My Access must show the first-play deadline from the current allocation rather than historical account age');
assert.equal(reentryHealth.tone,'warn','the existing My Access traffic-light must turn amber as the current allocation approaches its configured deadline');
const freshHealth=freeAccessHealth({
  applies:true,
  policy:{noPlaybackDays:4,minimumPlaybackMinutes:null,playbackWindowDays:7,minimumObservationHours:24},
  observationStartedAt:'2026-09-06T12:00:00.000Z',
  inactiveReferenceAt:'2026-09-06T12:00:00.000Z',
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(freshHealth.tone,'good','a newly allocated Free place must remain green while comfortably inside its first-play window');

assert.match(view,/accounts\.forEach\(function\(account\)/,'each Jellyfin or Emby server account must remain independently renderable instead of using a single server selector');
assert.match(view,/hasStremioAccess/,'My Access must render Stremio independently from Jellyfin account cards');
assert.match(view,/id="stremio-access"/,'Stremio access must have its own card below media-server access');
assert.match(view,/>manifest\.json</,'the Stremio card must expose the private manifest explicitly');
assert(view.indexOf('id="stremio-access"')<view.indexOf('id="overseerr"'),'Stremio must appear before the compact Overseerr password-reset section');
assert.match(stremioRoute,/r\.get\('\/account\/stremio\/installation\.json'/,'the signed-in Stremio route must expose the current manifest to My Access');
assert.match(stremioRoute,/req\.body\?\.returnTo==='access'/,'Stremio mutations launched from My Access must return to My Access');
assert.match(client,/fetch\('\/account\/stremio\/installation\.json'/,'My Access must hydrate its Stremio manifest from the customer-scoped endpoint');

console.log('customer My Access inactivity smoke: ok');
