'use strict';

const fs=require('fs');
const path=require('path');
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}
function expect(v,m){if(!v)throw new Error(m);}

const inactivity=source('src/automation/customer-inactivity.js');
expect(inactivity.includes("worker_key='activity'"),'Inactivity enforcement must require the activity worker heartbeat.');
expect(inactivity.includes("health_status='offline'")&&inactivity.includes("last_health_check<NOW()-INTERVAL '10 minutes'"),'Inactivity enforcement must reject stale/unhealthy Jellyfin telemetry.');
const telemetryGate=inactivity.indexOf("if(!telemetry.ready)return{processed:0,eligible:0,enforced:0,wouldDisable:0,released,dryRun:true,skipped:'telemetry_not_trustworthy'");
const candidateRun=inactivity.indexOf('const rows=await candidates(globalCfg)');
expect(telemetryGate>=0&&candidateRun>telemetryGate,'Free Server inactivity must fail closed before evaluating or enforcing new disables when telemetry is untrustworthy.');
expect(inactivity.indexOf('const globalCfg=await lifecyclePolicy.get(),released=await releaseObsoletePlanHolds')<telemetryGate,'Obsolete policy holds may be released before the telemetry gate so disabling a rule cannot strand Jellyfin access.');
expect(inactivity.includes("account_purpose='jellyfin'")&&!inactivity.includes("account_purpose='stremio_internal') first_account_at"),'Free Server inactivity age must use normal customer Jellyfin accounts, not hidden Stremio identities.');
expect(inactivity.includes('!row.currently_playing'),'A currently-playing customer must never become inactivity-eligible.');

const activityRoute=source('src/platform/customer-activity.js');
expect(activityRoute.includes('customer-inactivity-status'),'Customer Activity must expose the same canonical inactivity evidence used by automation.');
expect(activityRoute.includes('ph.playback_method'),'Customer Activity must select the playback_history playback_method column directly.');
expect(!activityRoute.includes('ph.play_method'),'Customer Activity must not query the nonexistent playback_history play_method column.');
expect(!activityRoute.includes('ph.max_height')&&!activityRoute.includes('ph.container'),'Customer Activity must not query nonexistent playback_history media-detail columns.');
expect(activityRoute.includes('observed_streams'),'Customer Activity must use the canonical observed stream count.');
const activityView=source('views/customer/activity.ejs');
expect(activityView.includes('Free Server usage'),'Customer Activity must explain Free Server usage status.');
expect(activityView.includes('Automatic inactivity removal is paused.'),'Customer Activity must tell customers when telemetry safety pauses removal.');
expect(activityView.includes('freeUsage.observed_streams')===false,'Customer Activity must not read observed streams from the wrong object.');
expect(activityView.includes('e.observed_streams'),'Stream-limit actions must render the canonical observed stream count.');
expect(!activityView.includes('a.max_height')&&!activityView.includes('a.container'),'Customer Activity must not render playback fields that are absent from playback_history.');

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

console.log('Customer playback trust and Seerr password sync smoke: ok');
