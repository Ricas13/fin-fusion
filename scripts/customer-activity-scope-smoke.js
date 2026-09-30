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

assert.equal(activity.scopeOption('all').accessLane,null);
assert.equal(activity.scopeOption('free').accessLane,'free');
assert.equal(activity.scopeOption('premium').accessLane,'primary');
assert.equal(activity.scopeOption('anything-else').key,'all');

assert.equal(activity.scopePredicate('all'),'');
assert.match(activity.scopePredicate('free'),/access_lane/,'Free activity must prefer the durable account lane');
assert.match(activity.scopePredicate('free'),/='free'/);
assert.match(activity.scopePredicate('premium'),/='primary'/,'Premium activity is the paid\/primary lane, including custom pools');
assert.match(activity.scopePredicate('free'),/CASE WHEN activity_scope_server\.server_class='free' THEN 'free' ELSE 'primary' END/,'orphaned historical rows need a server-pool fallback after account deletion');

assert.match(route,/insightData\(customerId,rawRange,rawScope='all'\)/,'analytics must accept a server scope');
assert.match(route,/scopeClause=scopePredicate\(scope,'ph'\)/,'analytics must apply the selected scope to playback history');
assert.match(route,/playbackScopeClause=scopePredicate\(scope,'ph'\)/,'recent playback must use the selected server scope');
assert.match(route,/eventScopeClause=scopePredicate\(scope,'stream_policy_events'\)/,'stream-policy events must use the selected server scope');
assert.match(route,/activity_scope_account\.access_lane/,'server scope must use the Jellyfin account lane when the account still exists');
assert.match(route,/req\.query\.range,req\.query\.scope/,'the activity route must accept both range and scope');

assert.match(view,/name="scope"[^>]*data-activity-scope-select/,'the activity page must expose a server selector');
assert.match(view,/All activity/,'the activity page must expose the combined scope');
assert.match(view,/scope=<%= encodeURIComponent\(scope\.key\) %>/,'range tabs must preserve the selected server scope');
assert.match(view,/freeUsage&&freeUsage\.applies&&scope\.key!=='premium'/,'Free retention status must not be shown as part of Premium-only analytics');
assert.match(view,/Premium Server viewing does not count toward it/,'Free retention panel must explain Premium playback exclusion');

assert.match(client,/data-activity-range-select\],\[data-activity-scope-select/,'range and server selectors must both auto-submit');

console.log('customer activity server scope smoke: ok');
