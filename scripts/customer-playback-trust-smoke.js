'use strict';

const fs=require('fs');
const path=require('path');
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}
function expect(v,m){if(!v)throw new Error(m);}

const inactivity=source('src/automation/customer-inactivity.js');
const scoped=source('src/automation/customer-inactivity-scoped.js');
const trust=source('src/jellyfin/activity-trust.js');
const worker=source('scripts/activity-worker.js');
const inactivityModule=require('../src/automation/customer-inactivity');
expect(scoped.includes("require('../jellyfin/activity-trust')"),'Inactivity must use the per-server activity trust owner.');
expect(!inactivity.includes("health_status='offline'")&&!inactivity.includes("last_health_check<NOW()-INTERVAL '10 minutes'"),'Free Server inactivity must not gate on fleet-wide server health.');
expect(scoped.includes('activityTrust.serverTelemetry(candidateServerIds(rows))'),'Scoped inactivity must request playback telemetry only for candidate servers.');
expect(!scoped.includes('fleetMetrics.refreshServerUserActivity')&&!scoped.includes('refreshCandidateUserActivity'),'The simplified inactivity path must not depend on a second /Users inventory freshness layer.');
const finalEligibilityIndex=scoped.indexOf('async function finalEligibility');
const finalCandidateReadIndex=scoped.indexOf('await base.candidates(globalCfg, { customerId: row.customer_id })',finalEligibilityIndex);
const finalTrustIndex=scoped.indexOf('activityTrust.serverTelemetry([fresh.server_id])',finalCandidateReadIndex);
const finalEntitlementIndex=scoped.indexOf('subscriptionState.liveFreeJellyfinSubscription(',finalTrustIndex);
expect(finalEligibilityIndex>=0&&finalCandidateReadIndex>finalEligibilityIndex&&finalTrustIndex>finalCandidateReadIndex&&finalEntitlementIndex>finalTrustIndex,'Final inactivity eligibility must re-read the exact account, verify fresh server playback telemetry and then re-check the exact Free entitlement.');
expect(scoped.includes('eligibleOnReadyServers')&&scoped.includes("serverTelemetry[String(row.server_id)]"),'Each inactivity candidate must be gated by its own server.');
expect(scoped.includes("'customer.inactivity.skipped'")&&scoped.includes('server_poll_untrusted'),'Unsafe telemetry must produce an explicit inactivity skip audit reason.');
expect(scoped.includes('finalEligibility(original, globalCfg)')&&scoped.includes('usage_no_longer_eligible'),'Enforcement must re-read playback evidence immediately before deleting access.');
expect(!scoped.includes('usageSatisfiedEarlierToday'),'The simplified two-rule path must not retain a duplicate same-day usage rule.');
expect(scoped.includes('provisioning.deleteJellyfinAccount')&&!scoped.includes('provisioning.reconcileCustomer(row.customer_id)'),'Inactivity removal must delete only the exact Free Jellyfin account instead of invoking broad customer reconciliation.');
expect(scoped.includes('requireNoActivePlayback: true'),'Automatic inactivity deletion must require a live no-playback precondition at the destructive boundary.');
const provisioningEngine=source('src/jellyfin/provisioning-engine.js');
expect(provisioningEngine.includes('assertNoActivePlaybackBeforeDelete')&&provisioningEngine.includes("registry.request(account.server_id, '/Sessions'")&&provisioningEngine.includes('JELLYFIN_ACTIVE_PLAYBACK_DELETE_BLOCKED'),'The exact-account delete primitive must fail closed if playback starts immediately before deletion.');
const laneStreamPolicy=source('src/jellyfin/lane-stream-policy.js');
expect(laneStreamPolicy.includes('allSessions: activeSessions')&&laneStreamPolicy.includes('(verified.allSessions || verified.sessions)'),'Device logout fallback must preserve another active identity sharing the same device.');

const day=86400000;
const allocation=Date.UTC(2026,8,1,12,0,0);
const policy={firstPlaybackGraceDays:3,playbackWindowDays:7,minimumPlaybackMinutes:30};
const noPlayback=inactivityModule.assessUsage({allocation_start_at:new Date(allocation),playback_seconds:0},policy,allocation+4*day);
expect(noPlayback.firstPlaybackEligible===true&&noPlayback.usageEligible===false,'Rule 1 must remove an allocation that misses its first-play grace.');
const onTime=inactivityModule.assessUsage({allocation_start_at:new Date(allocation),first_playback_at:new Date(allocation+day),last_playback_at:new Date(allocation+day),playback_seconds:29*60},policy,allocation+9*day);
expect(onTime.firstPlaybackEligible===false&&onTime.usageEligible===true,'Rule 2 must apply only after an on-time first play and one full rolling window.');
const late=inactivityModule.assessUsage({allocation_start_at:new Date(allocation),first_playback_at:new Date(allocation+4*day),last_playback_at:new Date(allocation+4*day),playback_seconds:60*60},policy,allocation+10*day);
expect(late.firstPlaybackOnTime===false&&late.firstPlaybackEligible===true&&late.usageEligible===false,'Late playback must not retroactively activate an allocation that already missed its first-play deadline.');
const oldPlayback=inactivityModule.assessUsage({allocation_start_at:new Date(allocation),first_playback_at:new Date(allocation-day),last_playback_at:new Date(allocation-day),playback_seconds:60*60},policy,allocation+4*day);
expect(oldPlayback.hasPlayback===false&&oldPlayback.firstPlaybackEligible===true,'Playback before the allocation boundary must not satisfy a newly added Free allocation.');
expect(inactivity.includes("WHERE ph.started_at>=allocation.allocation_start_at")&&inactivity.includes("GREATEST(\n                      ph.started_at,\n                      NOW()-(js.free_playback_window_days||' days')::interval"),'Free playback must start inside the current allocation while still counting exact overlap at the rolling-window boundary.');
expect(trust.includes('successMs < attemptMs')&&trust.includes("reason = 'last_poll_failed'"),'A newer failed poll must not be hidden by an older success.');
expect(trust.includes('cfg.pollSeconds + cfg.slackSeconds'),'Server trust must expire at poll interval plus slack.');
expect(worker.includes("STREAM_POLICY_POLL_SECONDS || 20")&&worker.includes('Math.max(15'),'Playback poll default must be 20s with a 15s floor.');
expect(worker.includes('activityTrust.recordCycle(serverIds, result.serverFailures || []'),'The activity worker must persist current-cycle per-server poll outcomes.');
const abortedPollIndex=worker.indexOf('await recordAbortedActivityCycle(error)');
const householdPolicyIndex=worker.indexOf('householdNetworkPolicy.runHouseholdNetworkCycle');
expect(abortedPollIndex>=0&&householdPolicyIndex>abortedPollIndex,'Secondary household-policy failures must occur outside the playback-poll failure boundary and must not overwrite successful poll trust.');
expect(worker.includes("Household network policy cycle failed:"),'Household policy failures must degrade the worker independently instead of failing the playback poll.');

// Offline Premium boxes are intentionally absent from a Free-only telemetry
// scope. The pure summary must therefore stay ready when the one target Free
// server is trustworthy.
const scopedModule=require('../src/automation/customer-inactivity-scoped');
const freeOnlySummary=scopedModule.telemetrySummary({ready:true,activityWorkerAgeSeconds:20},{'free-server':{ready:true}});
expect(freeOnlySummary.ready===true&&freeOnlySummary.unsafeTargetServers===0,'An unrelated Premium server must not make a Free-only telemetry scope unsafe.');

const inactivityBase=source('src/automation/customer-inactivity.js');
expect(inactivityBase.includes("account_purpose='jellyfin'")&&!inactivityBase.includes("account_purpose='stremio_internal') first_account_at"),'Free Server inactivity age must use normal customer Jellyfin accounts, not hidden Stremio identities.');
expect(inactivityBase.includes('!row.currently_playing'),'A currently-playing customer must never become inactivity-eligible.');

const webhook=source('src/jellyfin/playback-webhook.js');
const webhookRoute=source('src/platform/webhooks.js');
expect(webhookRoute.includes("/webhooks/jellyfin/:serverId")&&webhookRoute.includes('x-fin-fusion-webhook-secret'),'Jellyfin playback ingest must use the documented shared-secret endpoint.');
expect(webhook.includes("['playbackstart','playbackprogress','playbackstop']"),'Webhook ingest must accept Start, Progress and Stop.');
expect(webhook.includes("registry.request(serverId, '/Sessions?activeWithinSeconds=120')")&&webhook.includes('pollPlaybackKey(serverId, match)'),'Webhook Start/Progress must converge on the poller session/playback key when Jellyfin exposes the live session.');
expect(webhook.includes('ON CONFLICT(server_id,playback_key) DO UPDATE'),'Webhook/poll observations must share the playback_history idempotency key.');
expect(webhook.includes("ended_at=COALESCE(ended_at,$3)")&&webhook.includes("ended_reason=COALESCE(ended_reason,'webhook_stop')"),'Duplicate Stop events must close a playback history row once.');
expect(webhook.includes('last_seen_at=GREATEST(last_seen_at,$3)'),'Playback Progress, including paused progress, must advance last-seen evidence.');
expect(webhook.includes('function startedAt(_payload, at)')&&webhook.includes('return at;'),'Webhook history must start at the observed event time, not at the media position.');
expect(!webhook.includes('at.getTime() - elapsedMs'),'Jellyfin media position must never be converted into historical watched minutes.');

const migration=source('db/migrations/108_activity_poll_trust.sql');
expect(migration.includes('jellyfin_activity_poll_state'),'Per-server activity poll state migration must exist.');
expect(migration.includes('playback_history_not_seen_grace_trigger')&&migration.includes('active_playback_delete_grace_trigger'),'Missing poll sessions must remain open until grace expires.');
expect(migration.includes('NEW.ended_at := COALESCE(OLD.ended_at, observed_at, OLD.last_seen_at)'),'Grace expiry must close at the last server-reported timestamp rather than inventing watched seconds.');

const activityRoute=source('src/platform/customer-activity.js');
expect(activityRoute.includes('customer-inactivity-status'),'Customer Activity must expose the same canonical inactivity evidence used by automation.');
expect(activityRoute.includes('ph.playback_method'),'Customer Activity must select the playback_history playback_method column directly.');
expect(!activityRoute.includes('ph.play_method'),'Customer Activity must not query the nonexistent playback_history play_method column.');
expect(!activityRoute.includes('ph.max_height')&&!activityRoute.includes('ph.container'),'Customer Activity must not query nonexistent playback_history media-detail columns.');
expect(activityRoute.includes('observed_streams'),'Customer Activity must use the canonical observed stream count.');
const activityView=source('views/customer/activity.ejs');
expect(activityView.includes('Based on what the server reported.')&&activityView.includes('Short clips under ~30s may not appear.'),'Free Server usage must disclose the limits of server-reported playback.');
expect(activityView.includes('this Free Server has a trustworthy recent playback sample'),'Customer Activity must explain scoped telemetry safety.');
expect(activityView.includes('freeUsage.observed_streams')===false,'Customer Activity must not read observed streams from the wrong object.');
expect(activityView.includes('e.observed_streams'),'Stream-limit actions must render the canonical observed stream count.');
expect(!activityView.includes('a.max_height')&&!activityView.includes('a.container'),'Customer Activity must not render playback fields that are absent from playback_history.');
expect(activityView.includes("case'transcode':return'Server transcoding'")&&activityView.includes('playbackLabel(a.playback_method)'),'Playback method must use neutral human-readable copy.');
expect(!activityView.includes('<span class="pill"><%= a.playback_method'),'Playback method must not be rendered as a quality-style pill.');
expect(!activityView.includes("a.playback_method === 'transcode'")&&!activityView.includes("a.playback_method === 'Transcode'"),'Playback method must not be rendered as a transcode quality score.');

const enforcement=source('src/jellyfin/activity.js');
expect(!enforcement.includes('if (!stillPresent.supportsMediaControl)'),'Stream enforcement must not abandon a confirmed violation solely because the client omits media-control support.');
expect(enforcement.includes('/Message')&&enforcement.includes('Concurrent stream limit reached')&&enforcement.includes('No additional concurrent streams are allowed'),'Excess playback must receive a clear best-effort concurrency-limit message before enforcement.');
expect(enforcement.includes('/Playing/Stop')&&enforcement.includes('verifyAfterStop'),'A Jellyfin stop response must be live-revalidated instead of being assumed successful.');
expect(enforcement.includes('/Devices?id=')&&enforcement.includes('device_logout_fallback'),'Ignored client stop commands must have a device-logout fallback.');
expect(enforcement.includes('device_logout_blocked_to_preserve_other_active_session'),'The device fallback must refuse to terminate another allowed active session sharing the same device.');
expect(enforcement.includes('jellyfin_stop_did_not_end_session'),'A 204/no-op Jellyfin stop must be recorded as a real enforcement failure rather than a false success.');

const dashboard=source('views/customer/dashboard.ejs');
expect(dashboard.includes('/account/activity')&&dashboard.includes('View playback activity'),'Dashboard must provide a direct playback-activity shortcut.');
const nav=source('views/customer/_nav.ejs');
expect(!nav.includes('>Service passwords</a>')&&nav.includes('data-customer-now-playing')&&nav.includes('>My Access</a>'),'Service credentials must live in My Access while the shared navigation owns the live-session strip.');
const passwordSync=source('src/platform/customer-password-sync.js');
expect(passwordSync.includes("scope:'customer-request-password',max:10,windowSeconds:900"),'Overseerr password changes must be separately rate limited.');
expect(passwordSync.includes("router.post('/account/requests/password',requireCustomer,requestPasswordLimit"),'The independent Overseerr password mutation must use its dedicated rate limiter.');
expect(passwordSync.includes("router.get('/account/service-passwords/fragment'")&&passwordSync.includes('servicePasswordFragment(req'),'The old entitlement-aware service-password fragment must remain a compatibility response for legacy clients.');
expect(passwordSync.includes("router.get('/account/service-passwords',requireCustomer,(_req,res)=>res.redirect(302,'/account/access'))")&&passwordSync.includes("router.get('/account/requests/password',requireCustomer,(_req,res)=>res.redirect(302,'/account/access#overseerr'))"),'Legacy service-password URLs must converge on My Access.');
expect(passwordSync.includes("return res.redirect('/account/access')"),'Fresh Jellyfin or Emby password setup must converge on My Access.');
expect(!passwordSync.includes('bcrypt.compare(')&&!passwordSync.includes('currentPortalPassword'),'Service password management must not read or verify the portal password.');
expect(passwordSync.includes("'customer.request_password.change'"),'Successful Overseerr password changes must be audited without logging the password.');
expect(passwordSync.includes('Portal and Overseerr passwords are separate.'),'The retired sync endpoint must explicitly keep portal and Overseerr credentials separate.');
expect(!passwordSync.includes('metadata:{password'),'Service password audit must never include plaintext secrets.');

const accessHub=source('src/platform/customer-jellyfin.js');
expect(accessHub.includes("router.post('/account/access/media/:accountId/password'")&&accessHub.includes("router.post('/account/access/requests/password'"),'My Access must own the visible media-service and Overseerr password mutations.');
const accessView=source('views/customer/jellyfin.ejs');
expect(accessView.includes('/account/libraries/<%= account.id %>')&&accessView.includes('A Free Server and a 24-hour trial can therefore have different selections'),'My Access library selection must stay account/server scoped for concurrent Jellyfin lanes.');

const nowPlaying=source('src/platform/customer-now-playing.js');
expect(nowPlaying.includes('WHERE aps.customer_id=$1'),'Now-playing reads must always be scoped to the signed-in customer.');
expect(nowPlaying.includes("aps.last_seen_at>NOW()-INTERVAL '5 minutes'"),'Now-playing must reject stale playback snapshots.');
expect(!nowPlaying.includes('remote_endpoint_encrypted')&&!nowPlaying.includes('jellyfin_session_id'),'Customer now-playing responses must not expose private endpoints or Jellyfin session IDs.');
expect(passwordSync.includes('router.use(createCustomerNowPlayingRouter())'),'The mounted customer account router must own the now-playing JSON endpoint before the general platform router.');
const nowPlayingClient=source('public/js/customer-now-playing.js');
expect(nowPlayingClient.includes("fetch('/account/now-playing.json'")&&nowPlayingClient.includes('window.setInterval(refresh,15000)'),'The live-stream strip must refresh from the customer-scoped endpoint without polling Jellyfin directly from the browser.');

console.log('Customer playback trust, webhook ingest, independent service password and now-playing smoke: ok');
