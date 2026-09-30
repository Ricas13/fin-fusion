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

assert.match(route,/jellyfin-cleanup-return/,'My Access may still restore a cleaned profile for a currently active non-inactivity plan');
assert.match(route,/cleanupReturn\.returningCustomerStatus\(customerId\)/,'My Access must still resolve generic cleanup state before rendering subscriptions');
assert.doesNotMatch(route,/function markRemovedFreeAccess\(/,'Free inactivity removal must not decorate a retained entitlement because the Free plan ends');
assert.doesNotMatch(route,/access_removed:true,access_removed_reason:'inactivity'/,'Free inactivity removal must not preserve a hidden restorable plan state');
assert.match(route,/Your Free Server access was removed because of inactivity\. You now have no active Free Server plan/,'My Access must send inactivity-removed customers to an explicit no-plan state');

assert.doesNotMatch(view,/Restore Free Server access/,'My Access must not offer one-click restoration after inactivity removal');
assert.doesNotMatch(view,/underlying Free Server entitlement is retained/i,'My Access must not claim an inactivity-removed Free entitlement is retained');
assert.match(view,/class="freeWatchLabel">Free Server activity requirement</,'Free Server access must identify the activity requirement explicitly');
assert.match(route,/Only playback through your Free Server access counts; playback through paid\/Premium access does not count toward this requirement\./,'My Access must explicitly say paid/Premium access does not satisfy Free retention');
assert.match(view,/freeAccessHealth--<%= freeHealth\.tone %>/,'My Access styling must be driven by shared Free Server health state');
assert.match(view,/Current <%= Number\(freeHealth\.playbackWindowDays\)\|\|7 %>-day window/,'Free Server watch status must show the current rolling window');

assert.match(route,/const missedFirstPlaybackDeadline=Boolean\(firstPlayback&&status\.firstPlaybackOnTime===false\)/,'My Access must distinguish late playback from valid activation');
assert.match(route,/const activated=Boolean\(!missedFirstPlaybackDeadline&&\(firstPlayback\|\|status\.hasPlayback\|\|status\.currentlyPlaying\)\)/,'activation must come from on-time playback, never login/browse activity');
assert.match(route,/label:missedFirstPlaybackDeadline\?'First-play deadline missed':'Play something to activate'/,'pre-activation status must distinguish a still-actionable place from a missed first-play deadline');
assert.match(route,/const minimumMet=playbackMinutes>=minimumPlaybackMinutes/,'post-activation health must depend only on rolling watched minutes');
assert.match(route,/const tone=minimumMet\?'good':'bad'/,'there must be no invented third/yellow activity rule');
assert.doesNotMatch(route,/activityReference=inactiveReference\|\|lastActivity\|\|lastPlayback/,'Jellyfin login/activity must not affect retention health');
assert.doesNotMatch(route,/noPlaybackDays/,'My Access must not expose the retired login/activity rule');

assert.match(status,/const discoveryCfg = globalCfg\.enabled[\s\S]*?\{ \.\.\.globalCfg, enabled: true \}/,'My Access health must remain discoverable when lifecycle enforcement is paused');
assert.match(status,/eligible: Boolean\(row\.eligible && globalCfg\.enabled && enforcementReady\)/,'paused lifecycle must never be shown as removal-eligible');
assert.match(status,/playbackMinutes: Math\.floor\(playbackSeconds \/ 60\)/,'My Access must count only completed playback minutes');
assert.doesNotMatch(status,/refreshCandidateUserActivity/,'My Access status must not perform a second Jellyfin user/login inventory refresh');

const preFirst=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-09-05T12:00:00.000Z',
  firstPlaybackAt:null,
  lastPlaybackAt:null,
  lastActivityAt:'2026-09-07T11:00:00.000Z',
  hasPlayback:false,
  playbackMinutes:0,
  currentlyPlaying:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(preFirst.tone,'bad');
assert.equal(preFirst.activated,false,'recent login activity must not activate the allocation');
assert.equal(preFirst.label,'Play something to activate','an in-grace unactivated place must tell the customer exactly what to do');
assert.equal(preFirst.removalAt.toISOString(),'2026-09-08T12:00:00.000Z');

const lateFirst=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-09-05T12:00:00.000Z',
  firstPlaybackAt:'2026-09-08T12:00:01.000Z',
  hasPlayback:true,
  firstPlaybackOnTime:false,
  playbackMinutes:10,
  currentlyPlaying:false,
  enforcementReady:true,
  eligible:true
},{now:Date.parse('2026-09-08T12:10:00.000Z')});
assert.equal(lateFirst.activated,false,'late playback must not be presented as a valid activation');
assert.equal(lateFirst.label,'First-play deadline missed');
assert.match(lateFirst.detail,/after the activation deadline/i);

const belowMinimum=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  lastPlaybackAt:'2026-09-06T12:00:00.000Z',
  lastActivityAt:'2026-09-07T11:59:00.000Z',
  hasPlayback:true,
  playbackMinutes:12,
  currentlyPlaying:false,
  enforcementReady:true,
  eligible:true
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(belowMinimum.tone,'bad','12 rolling minutes must be red regardless of recent login activity');
assert.equal(belowMinimum.minimumMet,false);
assert.equal(belowMinimum.activityMet,true,'compatibility field is neutral because there is no activity rule');
assert.equal(belowMinimum.label,'Needs playback');

const exactlyMet=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  lastPlaybackAt:'2026-09-06T12:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:30,
  currentlyPlaying:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(exactlyMet.tone,'good','30 rolling minutes must satisfy the requirement exactly');
assert.equal(exactlyMet.minimumMet,true);
assert.equal(exactlyMet.label,"You're good");

const currentlyPlaying=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:29,
  currentlyPlaying:true,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.equal(currentlyPlaying.minimumMet,false,'an in-progress stream does not fabricate watched minutes');
assert.match(currentlyPlaying.detail,/current stream is still being counted/i);

const protectedStatus=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:true,
  globalEnforcementEnabled:true,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.match(protectedStatus.detail,/protected account/i,'explicit admin/permanent protection must be visible without inventing another usage rule');
assert.equal(protectedStatus.removalAt,null,'after the initial retention window there is no fixed future removal timestamp');

const pausedStatus=freeAccessHealth({
  applies:true,
  policy:{firstPlaybackGraceDays:3,minimumPlaybackMinutes:30,playbackWindowDays:7},
  allocationStartAt:'2026-08-15T12:00:00.000Z',
  firstPlaybackAt:'2026-08-16T12:00:00.000Z',
  hasPlayback:true,
  playbackMinutes:0,
  currentlyPlaying:false,
  automationProtected:false,
  globalEnforcementEnabled:false,
  enforcementReady:true,
  eligible:false
},{now:Date.parse('2026-09-07T12:00:00.000Z')});
assert.match(pausedStatus.detail,/paused by the administrator/i,'global pause state must be visible to the customer-facing status');

assert.match(view,/accounts\.forEach\(function\(account\)/,'each Jellyfin or Emby server account must remain independently renderable');
assert.match(view,/hasStremioAccess/,'My Access must render Stremio independently');
assert.match(view,/id="stremio-access"/,'Stremio access must have its own card');
assert.match(view,/>manifest\.json</,'the Stremio card must expose the private manifest explicitly');
assert(view.indexOf('id="stremio-access"')<view.indexOf('id="overseerr"'),'Stremio must appear before Overseerr');
assert.match(stremioRoute,/r\.get\('\/account\/stremio\/installation\.json'/,'the signed-in Stremio route must expose the current manifest');
assert.match(stremioRoute,/req\.body\?\.returnTo==='access'/,'Stremio mutations launched from My Access must return to My Access');
assert.match(client,/fetch\('\/account\/stremio\/installation\.json'/,'My Access must hydrate its Stremio manifest');

console.log('customer My Access inactivity smoke: ok');
