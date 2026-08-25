'use strict';

const fs=require('fs');
const path=require('path');
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}
function expect(v,m){if(!v)throw new Error(m);}

const inactivity=source('src/automation/customer-inactivity.js');
expect(inactivity.includes("worker_key='activity'"),'Inactivity enforcement must require the activity worker heartbeat.');
expect(inactivity.includes("health_status='offline'")&&inactivity.includes("last_health_check<NOW()-INTERVAL '10 minutes'"),'Inactivity enforcement must reject stale/unhealthy Jellyfin telemetry.');
expect(inactivity.includes("if(!telemetry.ready)return{processed:0,eligible:0,enforced:0,dryRun:true,skipped:'telemetry_not_trustworthy'"),'Free Server inactivity enforcement must fail closed when telemetry is untrustworthy.');
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

const dashboard=source('views/customer/dashboard.ejs');
expect(dashboard.includes('/account/activity')&&dashboard.includes('View playback activity'),'Dashboard must provide a direct playback-activity shortcut.');
expect(dashboard.includes('/account/requests/password/sync')&&dashboard.includes('currentPortalPassword'),'Dashboard must expose explicit portal-password sync to Seerr.');
expect(dashboard.includes('plaintext password is not stored'),'Password-sync copy must explain the secret boundary.');
const legacy=source('src/platform/router-runtime-legacy.js');
expect(legacy.includes("scope:'customer-request-password-sync',max:5,windowSeconds:900"),'Seerr password sync must be separately rate limited.');
expect(legacy.includes('bcrypt.compare(password,row.rows[0].password_hash)'),'Seerr sync must verify the current portal password before sending it to Seerr.');
expect(legacy.indexOf('verifyPortalPassword(req.session.customerUserId,portalPassword)')<legacy.indexOf('requestUserSync.setCustomerPassword(req.session.customerId,portalPassword)'),'Portal password verification must happen before Seerr mutation.');
expect(legacy.includes("'customer.request_password.sync_from_portal'"),'Successful password sync must be audited without logging the password.');
expect(!legacy.includes('metadata:{password'),'Password sync audit must never include plaintext secrets.');

console.log('Customer playback trust and Seerr password sync smoke: ok');
