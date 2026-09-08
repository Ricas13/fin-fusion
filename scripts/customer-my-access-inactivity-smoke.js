'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const {freeAccessHealth}=require('../src/platform/customer-jellyfin');

const route=read('src/platform/customer-jellyfin.js');
const status=read('src/automation/customer-inactivity-status.js');
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
assert.match(view,/freeAccessHealth--<%= freeHealth\.tone %>/,'My Access traffic-light styling must be driven by the shared Free Server health state');
assert.match(view,/Current <%= Number\(freeHealth\.playbackWindowDays\)\|\|7 %>-day window/,'Free Server watch status must show the current playback window');
assert.match(route,/const activated=Boolean\(firstPlayback\|\|status\.hasPlayback\|\|status\.currentlyPlaying\)/,'My Access must derive activation from allocation-scoped playback evidence, not login or browse activity');
assert.match(route,/return\{tone:'bad',label:'Play something to activate'/,'My Access must stay red before the first stream');
assert.match(route,/const activityReference=inactiveReference\|\|lastActivity\|\|lastPlayback/,'My Access must evaluate recent activity using the canonical activity reference');
assert.match(route,/const tone=allMet\?'good':metCount>0\?'warn':'bad'/,'post-activation health must be green for both checks, yellow for one and red for neither');
assert.match(status,/const discoveryCfg=globalCfg\.enabled\?globalCfg:\{\.\.\.globalCfg,enabled:true\}/,'My Access health must remain discoverable when lifecycle enforcement is globally paused');
assert.match(status,/lastActivityAt:row\.last_activity_at\|\|null/,'My Access status must expose refreshed Jellyfin account activity');
assert.match(status,/eligible:Boolean\(row\.eligible&&globalCfg\.enabled&&enforcementReady\)/,'a paused global lifecycle must never be presented as removal-eligible');
assert.match(status,/playbackMinutes:Math\.floor\(playbackSeconds\/60\)/,'My Access must count only completed playback minutes so it cannot show 30 minutes before the backend threshold is actually met');

const preFirst=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,noPlaybackDays:7,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24},
  allocationStartAt:'2026-09-05T12:00:00.000Z',
  firstPlaybackAt:null,
  lastPlaybackAt:null,
  lastActivityAt:'2026-09-07T11:00:00.000Z',
  observationStartedAt:'2026-09-05T12:00:00.000Z',
  inactiveReferenceAt:'2026-09-07T11:00:00.000Z',
  hasPlayback:false,
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(preFirst.tone,'bad','a Free place must stay red until the customer actually plays something, even if Jellyfin login activity is recent');
assert.equal(preFirst.activated,false,'non-playback activity must not activate a restored or new allocation');
assert.equal(preFirst.removalAt.toISOString(),'2026-09-08T12:00:00.000Z','My Access must show the independent three-day first-play deadline from the current allocation');

const yellow=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,noPlaybackDays:7,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  lastPlaybackAt:'2026-08-29T12:00:00.000Z',
  lastActivityAt:'2026-09-06T12:00:00.000Z',
  observationStartedAt:'2026-08-16T12:00:00.000Z',
  inactiveReferenceAt:'2026-09-06T12:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:12,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(yellow.tone,'warn','an activated Free place with recent Jellyfin activity but insufficient watch minutes must be yellow');
assert.equal(yellow.activityMet,true,'recent Jellyfin activity must satisfy the seven-day activity condition even when playback itself is old');
assert.equal(yellow.minimumMet,false,'twelve minutes must not satisfy the thirty-minute condition');

const green=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,noPlaybackDays:7,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24},
  allocationStartAt:'2026-09-01T12:00:00.000Z',
  firstPlaybackAt:'2026-09-02T12:00:00.000Z',
  lastPlaybackAt:'2026-09-06T12:00:00.000Z',
  lastActivityAt:'2026-09-06T18:00:00.000Z',
  observationStartedAt:'2026-09-02T12:00:00.000Z',
  inactiveReferenceAt:'2026-09-06T18:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:35,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(green.tone,'good','an activated Free place meeting both ongoing checks must be green');
assert.equal(green.activityMet,true);
assert.equal(green.minimumMet,true);

const postActivationRed=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,noPlaybackDays:7,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24},
  allocationStartAt:'2026-08-20T12:00:00.000Z',
  firstPlaybackAt:'2026-08-21T12:00:00.000Z',
  lastPlaybackAt:'2026-08-30T12:00:00.000Z',
  lastActivityAt:'2026-08-30T18:00:00.000Z',
  observationStartedAt:'2026-08-21T12:00:00.000Z',
  inactiveReferenceAt:'2026-08-30T18:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:false,
  enforcementReady:true,
  eligible:true
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(postActivationRed.tone,'bad','after activation the card must return to red when neither ongoing requirement is met');
assert.equal(postActivationRed.activityMet,false);
assert.equal(postActivationRed.minimumMet,false);

assert.match(view,/accounts\.forEach\(function\(account\)/,'each Jellyfin or Emby server account must remain independently renderable instead of using a single server selector');
assert.match(view,/hasStremioAccess/,'My Access must render Stremio independently from Jellyfin account cards');
assert.match(view,/id="stremio-access"/,'Stremio access must have its own card below media-server access');
assert.match(view,/>manifest\.json</,'the Stremio card must expose the private manifest explicitly');
assert(view.indexOf('id="stremio-access"')<view.indexOf('id="overseerr"'),'Stremio must appear before the compact Overseerr password-reset section');
assert.match(stremioRoute,/r\.get\('\/account\/stremio\/installation\.json'/,'the signed-in Stremio route must expose the current manifest to My Access');
assert.match(stremioRoute,/req\.body\?\.returnTo==='access'/,'Stremio mutations launched from My Access must return to My Access');
assert.match(client,/fetch\('\/account\/stremio\/installation\.json'/,'My Access must hydrate its Stremio manifest from the customer-scoped endpoint');

console.log('customer My Access inactivity smoke: ok');