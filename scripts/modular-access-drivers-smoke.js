'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const modules=require('../src/modules/registry');
const drivers=require('../src/access/drivers');
const components=require('../src/access/plan-components');
const identity=require('../src/access/network-identity');
const policy=require('../src/jellyfin/policy');

const defaultModules=modules.snapshot({enabledModules:''});
assert(defaultModules.modules.every(item=>item.enabled),'legacy/self-hosted compatibility must not disable shipped modules before licensing is configured');
const limited=modules.snapshot({enabledModules:'jellyfin',deploymentMode:'hosted',tenantKey:'tenant-a'});
assert.strictEqual(limited.deploymentMode,'hosted');
assert.strictEqual(limited.tenantKey,'tenant-a');
assert(modules.isEnabled('jellyfin',{enabledModules:'jellyfin'}));
assert(!modules.isEnabled('stremio',{enabledModules:'jellyfin'}));
assert.strictEqual(modules.definition('reseller'),null,'CAPTAiNFiN must not ship a reseller product module');
assert(!modules.ids().includes('reseller'),'reseller must not appear in the shipped module catalogue');
assert(modules.definition('affiliate').capabilities.includes('affiliate.access'),'the neutral module/capability extension seam must remain intact for separately-owned future projects');

const streamPlan={service_type:'jellyfin',jellyfin_access_model:'concurrent_streams',streams:3};
const streamComponent=components.componentForPlan(streamPlan,'jellyfin');
assert.strictEqual(streamComponent.driver,'concurrent_streams');
assert.strictEqual(streamComponent.config.streamLimit,3);
assert.strictEqual(components.accessLabel(streamPlan),'3 Jellyfin streams');

const householdPlan={service_type:'jellyfin',jellyfin_access_model:'household_network',streams:null,jellyfin_household_network_limit:1,jellyfin_household_lease_minutes:180};
const householdComponent=components.componentForPlan(householdPlan,'jellyfin');
assert.strictEqual(householdComponent.driver,'household_network');
assert.deepStrictEqual(householdComponent.config,{networkLimit:1,leaseMinutes:180});
assert.strictEqual(components.accessLabel(householdPlan),'1 Jellyfin household network');
assert.deepStrictEqual(policy.effectiveTechnicalPolicy(householdPlan,{streams:9}).streams,{plan:null,override:null,effective:null},'stream overrides must not reactivate concurrent limits on a household plan');

const bundle={service_type:'bundle',jellyfin_access_model:'household_network',jellyfin_household_network_limit:2,jellyfin_household_lease_minutes:120,stremio_household_network_limit:3,stremio_household_lease_minutes:300};
const bundleComponents=components.componentsForPlan(bundle);
assert.strictEqual(bundleComponents.length,2);
assert.deepStrictEqual(bundleComponents.find(c=>c.module==='jellyfin').config,{networkLimit:2,leaseMinutes:120});
const bundleStremio=bundleComponents.find(c=>c.module==='stremio').config;
assert.strictEqual(bundleStremio.networkLimit,3,'Stremio household allowance must remain independently configurable on historical composite plans');
assert.strictEqual(bundleStremio.leaseMinutes,300,'Stremio must keep an independent lease duration');
assert.strictEqual(components.accessLabel({service_type:'stremio'}),'Unlimited streams · Unlimited devices · 1 household connection');

assert.strictEqual(identity.canonicalNetwork('203.0.113.44:8096'),'ipv4:203.0.113.44');
assert.strictEqual(identity.canonicalNetwork('::ffff:203.0.113.44'),'ipv4:203.0.113.44');
assert.strictEqual(identity.canonicalNetwork('[2001:db8:abcd:12::1]:443'),'ipv6:2001:0db8:abcd:0012::/64');
assert.strictEqual(identity.canonicalNetwork('2001:db8:abcd:12:ffff::99'),'ipv6:2001:0db8:abcd:0012::/64','IPv6 privacy addresses inside one /64 must share a household identity');
assert.notStrictEqual(identity.canonicalNetwork('2001:db8:abcd:13::1'),identity.canonicalNetwork('2001:db8:abcd:12::1'));
assert.strictEqual(identity.hashNetwork('203.0.113.44',{secret:'x'.repeat(32)}),identity.hashNetwork('203.0.113.44:8096',{secret:'x'.repeat(32)}),'canonical network hashing must ignore transport ports');
assert.strictEqual(drivers.householdConfig({household_network_limit:99,household_lease_minutes:1}).networkLimit,1,'invalid household limits must fail back to safe defaults');

const migration=read('db/migrations/023_modular_access_drivers.sql');
const familyMigration=read('db/migrations/024_network_lease_families.sql');
const leases=read('src/access/network-leases.js');
const stremio=read('src/stremio/runtime.js');
const managed=read('src/stremio/managed-runtime.js');
const external=read('src/stremio/external-direct-runtime.js');
const jellyfin=read('src/jellyfin/household-network-policy.js');
const worker=read('scripts/activity-worker.js');
const roleScript=read('scripts/configure-runtime-db-roles.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const planAccess=read('src/platform/admin-plan-access.js');
const composition=read('src/platform/admin-route-composition.js');
const storefront=read('src/platform/storefront-core.js');
const catalogVersioning=read('src/platform/catalog-versioning.js');

for(const token of ['jellyfin_access_model','jellyfin_household_network_limit','jellyfin_household_lease_minutes','stremio_household_lease_minutes','access_network_leases','access_network_events'])assert(migration.includes(token),`migration is missing ${token}`);
assert(migration.includes('ALTER COLUMN streams DROP NOT NULL'),'household Jellyfin plans must be able to represent a non-applicable stream count as NULL');
assert(familyMigration.includes('network_family')&&familyMigration.includes('access_network_leases_subject_family_idx'),'dual-stack household enforcement must persist the normalized IP family');
assert(leases.includes('pg_advisory_xact_lock'),'household lease claims must serialize per subject');
assert(leases.includes("decision === 'denied'")&&leases.includes("INTERVAL '5 minutes'"),'repeated denials must be audit-throttled');
assert(leases.includes('activeSameFamily')&&leases.includes('function preview'),'lease claims must enforce household limits per IP family and expose read-only availability checks');
assert(leases.includes('expires_at=NOW()+($6::int*INTERVAL'),'same-network playback must refresh a time-limited lease');
assert(!leases.includes('remote_endpoint'),'generic lease persistence must not store plaintext network endpoints');

assert(stremio.includes('claimHouseholdOrReject')&&stremio.includes("kind: 'direct_stream_result'"),'Stremio raw-file results must preserve household admission and compatibility-route checks');
assert(stremio.includes('managedRuntime.streamsFor(entitlement, type, videoId)')&&stremio.includes('externalRuntime.streamsFor(entitlement, type, videoId)'),'both Stremio source classes must return direct stream results from their source runtimes');
assert(managed.includes("url.searchParams.set('Static','true')")&&external.includes("url.searchParams.set('Static', 'true')"),'both Stremio source classes must construct Jellyfin static/original-file URLs');
assert(stremio.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'"),'legacy external Stremio playback-start links must remain compatible');
assert(stremio.includes('const PLAYBACK_REDIRECT_STATUS = 302')&&(stremio.match(/res\.redirect\(PLAYBACK_REDIRECT_STATUS, target\)/g)||[]).length>=2,'legacy managed and external control links must exit through plain temporary redirects');
assert(!stremio.includes('pipe(res)')&&!external.includes('pipe(res)'),'CAPTAiNFiN must never relay Stremio media bytes');
assert(external.includes('playbackTargetFor')&&external.includes('directPlaybackUrl'),'external compatibility links must resolve to direct Jellyfin delivery');
assert(!stremio.includes("require('./managed-playback-lifecycle')")&&!managed.includes('/PlaybackInfo'),'normal Stremio raw-file delivery must not create Jellyfin playback sessions');

assert(jellyfin.includes("scope: 'jellyfin'"),'Jellyfin household access must use the shared lease engine');
assert(jellyfin.includes('SELECT s.id AS subscription_id'),'Jellyfin household enforcement must use a narrow least-privilege entitlement projection');
assert(!jellyfin.includes('effectiveSubscription(customerId)'),'activity-worker household enforcement must not use the broad customer entitlement projection');
assert(jellyfin.includes("cfg.effectiveMode !== 'enforce'"),'Jellyfin household stopping must retain the existing observe/enforce safety gate');
assert(jellyfin.includes('freshSession(candidate'),'Jellyfin household enforcement must revalidate the session before stopping playback');
assert(worker.includes('householdNetworkPolicy.runHouseholdNetworkCycle'),'the activity worker must execute the Jellyfin household driver');
assert(roleScript.includes('access_network_leases')&&roleScript.includes('access_network_events'),'activity role bootstrap must grant only the household lease tables it needs');
assert(roleScript.includes('jellyfin_household_network_limit')&&roleScript.includes('jellyfin_household_lease_minutes'),'activity role must be able to read the new Jellyfin plan driver settings');

for(const token of ['jellyfinAccessModel','jellyfinHouseholdNetworkLimit','jellyfinHouseholdLeaseMinutes','stremioHouseholdLeaseMinutes'])assert(planCreate.includes(token),`plan creation is missing ${token}`);
assert(planAccess.includes("queuePlanReconciliation(plan.id"),'existing plan access changes must use the established reconciliation job fanout');
assert(planAccess.includes('clearPlanLeases'),'policy edits must invalidate old household lease state immediately');
assert(composition.indexOf('createAdminPlanAccessRouter()')<composition.indexOf('createAdminPlansRouter()'),'household-aware access routes must own the established endpoint before the legacy controller');
assert(storefront.includes('planComponents.accessLabel(plan)'),'public plan cards must render the shared component access model');
assert(catalogVersioning.includes("information_schema.columns")&&catalogVersioning.includes('source[c]'),'dynamic plan cloning must automatically preserve the new component-driver columns');

console.log('modular access drivers smoke: ok');
