'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const ejs=require('ejs');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const activity=require('../src/platform/customer-activity');

const route=read('src/platform/customer-activity.js');
const view=read('views/customer/activity.ejs');
const client=read('public/js/customer-activity.js');
const activityCollector=read('src/jellyfin/activity.js');
const playbackWebhook=read('src/jellyfin/playback-webhook.js');
const laneMigration=read('db/migrations/20260930211500_activity_access_lane_snapshot.sql');
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const forceAccess=read('src/platform/admin-customer-force-access.js');
const durableCreation=read('src/jellyfin/durable-account-creation.js');
const manualAssignment=read('src/jellyfin/manual-assignment.js');
const forceMove=read('src/jellyfin/admin-force-move.js');

assert.doesNotThrow(()=>ejs.compile(view,{filename:path.join(root,'views/customer/activity.ejs')}),'Activity EJS must remain syntactically compilable');

assert.equal(activity.scopeOption('all').accessLane,null);
assert.equal(activity.scopeOption('free').accessLane,'free');
assert.equal(activity.scopeOption('premium').accessLane,'primary');
assert.equal(activity.scopeOption('anything-else').key,'all');

assert.equal(activity.scopePredicate('all'),'');
assert.match(activity.scopePredicate('free'),/access_lane_snapshot/,'Free activity must prefer the immutable observation-time lane snapshot');
assert.match(activity.scopePredicate('free'),/access_lane_changed_at/,'legacy rows with a live account must respect explicit primary-to-Free transition boundaries');
assert.match(activity.scopePredicate('free'),/access_lane='primary'[\s\S]*THEN 'free'/,'legacy rows before a trustworthy Free-to-primary transition must remain visible as Free history');
assert.match(activity.scopePredicate('free'),/inactivity_observation_reset_at IS NULL/,'ambiguous legacy Free boundaries must not rewrite old history');
assert.match(activity.scopePredicate('free'),/='free'/);
assert.match(activity.scopePredicate('premium'),/='primary'/,'Premium activity is the paid\/primary lane, including custom pools');
assert.match(activity.scopePredicate('free'),/CASE WHEN activity_scope_server\.server_class='free' THEN 'free' ELSE 'primary' END/,'orphaned pre-snapshot history needs a server-pool fallback after account deletion');
assert.match(activity.scopePredicate('free','stream_policy_events','created_at'),/stream_policy_events\.created_at/,'stream-policy history must use its explicit event timestamp for lane-transition fallback');

assert.match(route,/insightData\(customerId,rawRange,rawScope='all'\)/,'analytics must accept a server scope');
assert.match(route,/scopeClause=scopePredicate\(scope,'ph'\)/,'analytics must apply the selected scope to playback history');
assert.match(route,/playbackScopeClause=scopePredicate\(scope,'ph'\)/,'recent playback must use the selected server scope');
assert.match(route,/eventScopeClause=scopePredicate\(scope,'stream_policy_events','created_at'\)/,'stream-policy events must use the selected server scope with the correct event timestamp');
assert.match(route,/COALESCE\(ph\.last_seen_at,ph\.started_at\)>?=\$2::timestamptz/,'detailed playback rows must respect the selected time period');
assert.match(route,/created_at>?=\$2::timestamptz/,'stream-policy rows must respect the selected time period');
assert.match(route,/activity_scope_account\.access_lane/,'server scope must use the Jellyfin account lane when a snapshot is unavailable');
assert.match(activityCollector,/access_lane_snapshot/,'poll-based playback and policy events must snapshot their access lane');
assert.match(playbackWebhook,/access_lane_snapshot/,'webhook-based playback must snapshot its access lane');
assert.doesNotMatch(activityCollector,/access_lane_snapshot=COALESCE\(playback_history\.access_lane_snapshot,EXCLUDED\.access_lane_snapshot\)/,'poll conflicts must not relabel a legacy playback row after an account lane transition');
assert.doesNotMatch(playbackWebhook,/access_lane_snapshot=COALESCE\(playback_history\.access_lane_snapshot,EXCLUDED\.access_lane_snapshot\)/,'webhook conflicts must not relabel a legacy playback row after an account lane transition');
assert.match(laneMigration,/ALTER TABLE playback_history[\s\S]*access_lane_snapshot/,'the migration must persist playback lane identity');
assert.match(laneMigration,/ALTER TABLE stream_policy_events[\s\S]*access_lane_snapshot/,'the migration must persist stream-policy lane identity');
assert.match(laneMigration,/ph\.started_at<ja\.access_lane_changed_at/,'historical backfill must separate paid-era playback before an explicit Free adoption');
assert.match(laneMigration,/ja\.access_lane='primary'[\s\S]*ph\.started_at<ja\.access_lane_changed_at[\s\S]*THEN 'free'/,'historical backfill must also preserve Free-era playback before an explicit transition back to primary');
assert.match(laneMigration,/UPDATE jellyfin_accounts[\s\S]*inactivity_observation_reset_at=NULL[\s\S]*access_lane_changed_at>inactivity_observation_reset_at/,'the migration must repair legacy safety markers that survived a later explicit lane transition');
assert.match(activity.scopePredicate('free'),/access_lane_changed_at>activity_scope_account\.inactivity_observation_reset_at/,'runtime scope fallback must also trust a lane boundary newer than the legacy safety marker');
assert.match(laneMigration,/ph\.jellyfin_account_id IS NOT NULL/,'historical lane snapshots must only be asserted when the original account identity is still known');
assert.doesNotMatch(laneMigration,/js\.server_class/,'the migration must not permanently guess an orphaned historical lane from server pool alone');
assert.match(resilientProvisioning,/SET access_lane='free'[\s\S]*access_lane_changed_at=NOW\(\)[\s\S]*inactivity_observation_reset_at=NULL/,'an explicit primary-to-Free adoption must replace the legacy synthetic marker with a trustworthy lane boundary');
assert.match(forceAccess,/const accessLane=provisioning\.requestedAccessLane\(entitlement\)/,'forced recovery must derive the recovered lane from the actual entitlement');
assert.match(forceAccess,/const accessLane=provisioning\.requestedAccessLane\(current\.entitlement\)[\s\S]*active=\(current\.activeAccounts\|\|\[\]\)\.filter\(account=>String\(account\.access_lane\|\|'primary'\)===accessLane\)/,'forced access must ignore an active account from the other lane when deciding whether the requested lane already exists');
assert.match(forceAccess,/access_lane_changed_at=CASE WHEN access_lane IS DISTINCT FROM \$5 THEN NOW\(\)[\s\S]*inactivity_observation_reset_at=CASE WHEN access_lane IS DISTINCT FROM \$5 THEN NULL[\s\S]*access_lane=\$5/,'forced recovery must record a real boundary for either Free or primary lane recovery');
assert.match(durableCreation,/access_lane_changed_at=CASE[\s\S]*access_lane IS DISTINCT FROM EXCLUDED\.access_lane THEN NOW\(\)[\s\S]*inactivity_observation_reset_at=CASE[\s\S]*access_lane IS DISTINCT FROM EXCLUDED\.access_lane THEN NULL/,'durable account recovery must clear a synthetic legacy marker whenever it performs a real lane transition');
assert.match(manualAssignment,/const accessLane=provisioning\.requestedAccessLane\(state\.entitlement\)/,'manual server assignment must derive the account lane from the entitlement rather than defaulting to paid\/primary');
assert.match(manualAssignment,/activeAccounts\.some\(account=>String\(account\.access_lane\|\|'primary'\)===accessLane\)/,'an active Free account must not block adding independent paid\/primary access, or vice versa');
assert.match(manualAssignment,/COALESCE\(access_lane,'primary'\)=\$3/,'manual assignment must only reuse an account from the entitlement lane instead of hijacking the other lane');
assert.match(manualAssignment,/access_lane_changed_at=CASE WHEN access_lane IS DISTINCT FROM \$2 THEN NOW\(\)[\s\S]*inactivity_observation_reset_at=CASE WHEN access_lane IS DISTINCT FROM \$2 THEN NULL[\s\S]*access_lane=\$2/,'reusing a manual-assignment account must record a trustworthy lane transition');
assert.match(manualAssignment,/allowOverCapacity:true,accessLane/,'new manual assignments must pass the entitlement lane into account creation explicitly');
assert.match(forceMove,/const accessLane=provisioning\.requestedAccessLane\(entitlement\)/,'forced server moves must derive the lane from the active entitlement');
assert.match(forceMove,/same\(account\.server_id,target\.id\)&&account\.access_lane===accessLane/,'forced server moves must not repurpose an account belonging to the other access lane');
assert.match(forceMove,/if\(String\(account\.access_lane\|\|'primary'\)!==accessLane\)continue/,'moving one Jellyfin lane must not delete the customer\'s independent other-lane account');
assert.match(forceMove,/allowOverCapacity:true,[\s\S]*accessLane/,'forced server moves must create the destination account in the entitlement lane explicitly');
assert.match(route,/req\.query\.range,req\.query\.scope/,'the activity route must accept both range and scope');

assert.match(view,/name="scope"[^>]*data-activity-scope-select/,'the activity page must expose a server selector');
assert.match(view,/All activity/,'the activity page must expose the combined scope');
assert.match(view,/scope=<%= encodeURIComponent\(scope\.key\) %>/,'range tabs must preserve the selected server scope');
assert.match(view,/freeUsage&&freeUsage\.applies&&scope\.key!=='premium'/,'Free retention status must not be shown as part of Premium-only analytics');
assert.match(view,/Paid\/Premium access does not count toward it/,'Free retention panel must explain paid/Premium access exclusion');

assert.match(client,/data-activity-range-select\],\[data-activity-scope-select/,'range and server selectors must both auto-submit');

console.log('customer activity server scope smoke: ok');
