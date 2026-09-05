'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('db/migrations/000_database_baseline.sql');
const sourceMigration=migration;
const binaryMigration=read('db/migrations/20260905110000_jellyfin_present_or_deleted.sql');
const deliveryContract=read('db/migrations/038_retire_stremio_delivery_identity_requirement.sql');
const policy=read('src/entitlements/jellyfin-lifecycle-policy.js');
const jobs=read('src/automation/jobs.js');
const inactivity=read('src/automation/customer-inactivity-scoped.js');
const helpers=read('src/jellyfin/provisioning-helpers.js');
const registry=read('src/jellyfin/registry.js');
const drift=read('src/jellyfin/drift-control.js');
const pool=read('src/stremio/source-pool.js');
const runtime=read('src/stremio/runtime.js');
const managed=read('src/stremio/managed-runtime.js');
const external=read('src/stremio/external-direct-runtime.js');
const entitlements=read('src/stremio/entitlements.js');
const admin=read('src/platform/admin-stremio-sources.js');

assert(policy.includes('freeNoPlaybackDays:7'),'Free Server must keep the seven-day activity policy default');
for(const retired of ['freeDeleteAfterDisableDays','trialDeleteAfterDisableDays','paidDeleteAfterDisableDays'])assert(!policy.includes(retired),`retired disable lifecycle setting must stay removed: ${retired}`);
assert(binaryMigration.includes('CHECK (disabled=FALSE)'),'database migration must make disabled Jellyfin account rows impossible');
assert(binaryMigration.includes('ON DELETE SET NULL'),'migration history must not prevent account deletion');
assert(binaryMigration.includes("status='pending'"),'legacy disabled identities must be queued for reconciliation during upgrade');
assert(helpers.includes('return deleteJellyfinAccount(account'),'legacy disable helper must converge to account deletion');
assert(registry.includes("MEDIA_USER_DISABLED_STATE_FORBIDDEN"),'media-server API boundary must reject disabled user policy writes');
const controlledFields=(drift.match(/const CONTROLLED_FIELDS=\[([^\]]+)\]/)||[])[1]||'';
assert(controlledFields&&!controlledFields.includes('EnableAllFolders')&&!controlledFields.includes('EnabledFolders'),'library/folder preferences must not be treated as access-consistency drift');
assert(!drift.includes("differences.push({field:'MissingLibraries'"),'missing or customer-selected libraries must not create access-consistency drift');
assert(controlledFields.includes('IsDisabled')&&controlledFields.includes('EnableAllDevices')&&controlledFields.includes('EnableMediaPlayback'),'access consistency must keep auditing platform-owned lifecycle and technical access fields');
assert(drift.includes("differences:[{field:'AccountPresence',expected:'absent',actual:'present'}]"),'access consistency must still detect obsolete managed accounts that should be absent');
assert(!fs.existsSync(path.join(root,'src/automation/jellyfin-lifecycle.js')),'superseded standalone Jellyfin lifecycle worker must stay removed');
assert(jobs.includes('async customer_inactivity(){return customerInactivity.run()}'),'automation must route customer inactivity through the current plan-aware owner');
assert(inactivity.includes('minimumPlaybackMinutes')&&inactivity.includes('activityWorkerTelemetry()'),'current inactivity owner must keep plan-aware playback and telemetry safety checks');
assert(inactivity.includes("customer.inactivity.remove_jellyfin"),'Free inactivity enforcement must remove Jellyfin access instead of disabling it');
assert(inactivity.includes("lifecycle: 'present_or_deleted'"),'Free inactivity audit must record the binary lifecycle invariant');
assert(!/UPDATE\s+customers|DELETE\s+FROM\s+customers/i.test(inactivity),'current inactivity lifecycle must never update/delete portal customers');
assert(policy.includes('portalAccountPreserved:true'),'policy audit must record portal preservation');
assert(/source_kind = 'owned'::text\) OR \(authorization_confirmed = true/.test(migration),'external Stremio sources must require authorization');
assert(pool.includes('Confirm that you are authorized'),'external source connection must enforce authorization');
assert(pool.includes('stremio_stream_attribution'),'source pool must retain CAPTAiNFiN attribution for operator-side source diagnostics');
assert(runtime.includes('managedRuntime.streamsFor')&&runtime.includes('externalRuntime.streamsFor'),'Stremio runtime must own separate managed and external resolution classes');
assert(/const streams\s*=\s*\[\s*\.\.\.managed\s*,\s*\.\.\.external\s*\]/.test(runtime),'managed Stremio results must be returned before external results');
assert(runtime.includes('STREAM_RESULT_CACHE_TTL_MS')&&runtime.includes('rememberStreams(entitlement.id, type, videoId, origin, streams)'),'Stremio stream discovery should cache short-lived allowed result sets');
assert(runtime.includes('Promise.allSettled(['),'managed and external result classes must resolve independently so one provider failure cannot hide healthy results');
assert(!managed.includes('/PlaybackInfo')&&!external.includes('/PlaybackInfo'),'managed and external Stremio delivery must both remain PlaybackInfo-free');
assert(managed.includes("url.searchParams.set('Static','true')")&&/url\.searchParams\.set\(\s*['"]Static['"]\s*,\s*['"]true['"]\s*\)/.test(external)&&external.includes('source.media_server_type'),'both Stremio source classes must return provider-aware static/original-file URLs');
assert(!runtime.includes("require('./managed-playback-lifecycle')"),'normal Stremio delivery must not create or report media-server playback sessions');
assert(admin.includes('External fallback playback goes directly to this Jellyfin server')&&/media bytes never pass through the portal/i.test(admin),'operator UI must remain transparent about direct upstream playback and the no-byte-proxy boundary');
assert(admin.includes('The password is stored encrypted only when automatic token rotation is enabled.')&&admin.includes('Libraries included in Stremio'),'operator UI must explain external credential storage and indexing boundaries');

// The clean-install baseline is a historical dump and still documents the old
// delivery-identity guard. Migration 038 must replace that trigger contract for
// both upgrades and fresh installs after all migrations have applied.
assert(sourceMigration.includes('selected shared sources or a managed Jellyfin delivery identity'),'historical baseline must retain the old Stremio delivery rule as an upgrade regression fixture');
assert(deliveryContract.includes('CREATE OR REPLACE FUNCTION public.enforce_stremio_entitlement_integrity()'),'latest migration must replace the Stremio entitlement trigger contract');
assert(!deliveryContract.includes("RAISE EXCEPTION 'Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity'"),'latest trigger must not require the retired entitlement-level delivery identity');
assert(deliveryContract.includes("RAISE EXCEPTION 'Active Stremio entitlement requires an install credential'"),'active Stremio entitlements must still require a customer install credential');
assert(deliveryContract.includes('Legacy managed Jellyfin delivery identity must be complete when attached to an active Stremio entitlement'),'attached legacy identities must remain all-or-nothing');
assert(deliveryContract.includes('UPDATE customer_provisioning_state')&&deliveryContract.includes('consecutive_failures=0')&&deliveryContract.includes('last_error=NULL'),'upgrade migration must reset the retired failure episode and requeue it');
assert(entitlements.includes('server_id=NULL,jellyfin_account_id=NULL')&&entitlements.includes('jellyfin_access_token_encrypted=NULL'),'current Stremio reconciliation must detach the retired entitlement-level Jellyfin identity');
assert(entitlements.includes("active:row.status==='active'&&Boolean(row.token_hash)"),'current source-based entitlement activity must depend on install activation, not a Jellyfin delivery identity');
assert(migration.includes('portal customer'),'migration must document portal identity invariant');
console.log('Jellyfin present-or-deleted lifecycle + Stremio Sources smoke: OK');
