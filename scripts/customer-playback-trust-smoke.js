'use strict';

const fs=require('fs');
const path=require('path');
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}
function expect(v,m){if(!v)throw new Error(m);}

const inactivity=source('src/automation/customer-inactivity.js');
const scoped=source('src/automation/customer-inactivity-scoped.js');
const trust=source('src/jellyfin/activity-trust.js');
const worker=source('scripts/activity-worker.js');
const planPolicy=require('../src/entitlements/plan-lifecycle-policy');
expect(inactivity.includes("require('../jellyfin/activity-trust')"),'Inactivity must use the per-server activity trust owner.');
expect(!inactivity.includes("health_status='offline'")&&!inactivity.includes("last_health_check<NOW()-INTERVAL '10 minutes'"),'Free Server inactivity must not gate on fleet-wide server health.');
expect(scoped.includes('activityTrust.serverTelemetry(candidateServerIds(rows))'),'Scoped inactivity must request playback telemetry only for candidate servers.');
expect(scoped.includes('fleetMetrics.refreshServerUserActivity(serverId)'),'Inactivity must retain the authoritative Jellyfin /Users freshness check.');
expect(scoped.includes('if (!poll?.ready) continue;'),'A /Users refresh must never promote a failed/stale /Sessions poll back to trusted.');
const finalEligibilityIndex=scoped.indexOf('async function finalEligibility');
const finalTrustIndex=scoped.indexOf('let serverTelemetry = await refreshCandidateServers([row]);',finalEligibilityIndex);
const finalUserRefreshIndex=scoped.indexOf('serverTelemetry = await refreshCandidateUserActivity([row], serverTelemetry);',finalTrustIndex);
const finalCandidateReadIndex=scoped.indexOf('await base.candidates(globalCfg, { customerId: row.customer_id })',finalUserRefreshIndex);
expect(finalEligibilityIndex>=0&&finalTrustIndex>finalEligibilityIndex&&finalUserRefreshIndex>finalTrustIndex&&finalCandidateReadIndex>finalUserRefreshIndex,'Final inactivity eligibility must refresh server trust and Jellyfin /Users activity before re-reading the candidate.');
expect(scoped.includes('eligibleOnReadyServers')&&scoped.includes("serverTelemetry[String(row.server_id)]"),'Each inactivity candidate must be gated by its own server.');
expect(scoped.includes("customer.inactivity.skipped_telemetry")&&scoped.includes('Free Server inactivity enforcement skipped'),'A failed Free Server sample must produce an explicit skip reason.');
expect(scoped.includes('finalEligibility(original, globalCfg)')&&scoped.includes('usage_no_longer_eligible'),'Enforcement must re-read playback evidence immediately before disabling access.');
expect(scoped.includes('usageSatisfiedEarlierToday')&&scoped.includes('usage_satisfied_earlier_today'),'A customer whose rolling minimum-playback usage was satisfied earlier the same day must not be disabled that day.');
const boundaryNow=Date.UTC(2026,7,29,13,0,0);
expect(planPolicy.noPlaybackBoundaryCrossedToday({noPlaybackEligible:true,referenceAt:new Date(Date.UTC(2026,7,22,12,0,0))},{noPlaybackDays:7},boundaryNow)===true,'A no-playback threshold crossed during the current day must defer inactivity action.');
expect(planPolicy.noPlaybackBoundaryCrossedToday({noPlaybackEligible:true,referenceAt:new Date(Date.UTC(2026,7,21,23,0,0))},{noPlaybackDays:7},boundaryNow)===false,'An account already below the no-playback rule before today must remain eligible.');
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
expect(dashboard.includes('/account/requests/password/sync')&&dashboard.includes('currentPortalPassword'),'Dashboard must expose explicit portal-password sync to Seerr.');
expect(dashboard.includes('plaintext password is not stored'),'Password-sync copy must explain the secret boundary.');
const passwordSync=source('src/platform/customer-password-sync.js');
expect(passwordSync.includes("scope:'customer-request-password-sync',max:5,windowSeconds:900"),'Seerr password sync must be separately rate limited.');
expect(passwordSync.includes('bcrypt.compare(password,row.rows[0].password_hash)'),'Seerr sync must verify the current portal password before sending it to Seerr.');
expect(passwordSync.indexOf('verifyPortalPassword(req.session.customerUserId,portalPassword)')<passwordSync.indexOf('requestUsers.setCustomerPassword(req.session.customerId,portalPassword)'),'Portal password verification must happen before Seerr mutation.');
expect(passwordSync.includes("'customer.request_password.sync_from_portal'"),'Successful password sync must be audited without logging the password.');
expect(!passwordSync.includes('metadata:{password'),'Password sync audit must never include plaintext secrets.');

console.log('Customer playback trust, webhook ingest and Seerr password sync smoke: ok');
