'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const activity=require('../src/platform/customer-activity');

const route=read('src/platform/customer-activity.js');
const view=read('views/customer/activity.ejs');
const client=read('public/js/customer-activity.js');
const activityCollector=read('src/jellyfin/activity.js');
const playbackWebhook=read('src/jellyfin/playback-webhook.js');
const laneMigration=read('db/migrations/20260930211500_activity_access_lane_snapshot.sql');

assert.equal(activity.scopeOption('all').accessLane,null);
assert.equal(activity.scopeOption('free').accessLane,'free');
assert.equal(activity.scopeOption('premium').accessLane,'primary');
assert.equal(activity.scopeOption('anything-else').key,'all');

assert.equal(activity.scopePredicate('all'),'');
assert.match(activity.scopePredicate('free'),/access_lane_snapshot/,'Free activity must prefer the immutable observation-time lane snapshot');
assert.match(activity.scopePredicate('free'),/access_lane_changed_at/,'legacy rows with a live account must respect explicit primary-to-Free transition boundaries');
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
assert.match(laneMigration,/ph\.jellyfin_account_id IS NOT NULL/,'historical lane snapshots must only be asserted when the original account identity is still known');
assert.doesNotMatch(laneMigration,/js\.server_class/,'the migration must not permanently guess an orphaned historical lane from server pool alone');
assert.match(route,/req\.query\.range,req\.query\.scope/,'the activity route must accept both range and scope');

assert.match(view,/name="scope"[^>]*data-activity-scope-select/,'the activity page must expose a server selector');
assert.match(view,/All activity/,'the activity page must expose the combined scope');
assert.match(view,/scope=<%= encodeURIComponent\(scope\.key\) %>/,'range tabs must preserve the selected server scope');
assert.match(view,/freeUsage&&freeUsage\.applies&&scope\.key!=='premium'/,'Free retention status must not be shown as part of Premium-only analytics');
assert.match(view,/Paid\/Premium access does not count toward it/,'Free retention panel must explain paid/Premium access exclusion');

assert.match(client,/data-activity-range-select\],\[data-activity-scope-select/,'range and server selectors must both auto-submit');

console.log('customer activity server scope smoke: ok');
