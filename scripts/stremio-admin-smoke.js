'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const application=read('src/application.js');
const router=read('src/platform/router.js');
const nav=read('src/platform/admin-nav.js');
const settings=read('src/platform/admin-original-settings.js');
const page=read('src/platform/admin-stremio.js');
const runtimeSettings=read('src/stremio/runtime-settings.js');
const migration=read('db/migrations/066_stremio_service_foundation.sql');
const runtimeMigration=read('db/migrations/069_stremio_runtime.sql');
const runtime=read('src/stremio/runtime.js');
const foundation=read('src/stremio/foundation.js');

assert(router.includes("createAdminStremioRouter"),'Stremio admin router must be mounted');
assert(application.includes('createStremioRuntimeRouter')&&application.includes('app.use(createStremioRuntimeRouter())'),'Stremio protocol runtime must have one canonical top-level owner');
assert(!router.includes('createStremioRuntimeRouter'),'Platform router must not duplicate the top-level Stremio protocol owner');
assert(nav.includes("'stremio-settings':'settings-integrations'"),'Stremio settings must map into the canonical Integrations settings group');
assert(settings.includes('href="/admin/settings/stremio"')&&settings.includes('<strong>Stremio</strong>'),'Stremio must be discoverable from Settings → Integrations');
assert(page.includes('Runtime disabled.')&&page.includes('Runtime ready.')&&page.includes('fail-closed'),'Admin page must surface explicit fail-closed/runtime-ready states');
assert(page.includes("action=\"/admin/settings/stremio/runtime\"")&&page.includes('Enable runtime')&&page.includes('Disable runtime'),'Runtime enablement must be managed from the Stremio admin page');
assert(page.includes('Configure the encryption key')&&page.includes('The encryption key itself never appears in the browser.'),'Setup guide must distinguish the secret key from the browser-managed runtime switch');
assert(!page.includes('name="STREMIO_JELLYFIN_TOKEN_KEY"'),'Dedicated token encryption key must never become a browser-editable form field');
assert(runtimeSettings.includes("KEY='stremio_runtime_v1'")&&runtimeSettings.includes('platform_settings')&&runtimeSettings.includes('setEnabled'),'Runtime state must persist in platform settings');
assert(runtimeSettings.includes('eligibleServers<1')&&runtimeSettings.includes('readyIndexes<1'),'Runtime enablement must fail closed until delivery and index prerequisites are ready');
assert(runtimeSettings.includes("'admin.stremio.runtime.update'"),'Runtime changes must be audited');
assert(foundation.includes('STREMIO_JELLYFIN_TOKEN_KEY')&&foundation.includes('runtimeSettings.enabled()')&&foundation.includes('runtimeReady'),'Runtime readiness must require both the browser-managed switch and dedicated restricted-token key');
assert(runtime.includes('runtimeSettings.ensureLoaded()')&&runtime.includes("if(!enabled())"),'Protocol surface must load browser-managed runtime state and fail closed while disabled');
assert(page.includes("status IN ('pending','active','suspended')"),'Server eligibility removal must protect all assigned non-revoked Stremio entitlements');
assert(page.includes("'admin.stremio.server_eligibility'"),'Server eligibility changes must be audited');
assert(page.includes("routeRateLimit.middleware({scope:'admin-stremio-settings'"),'Stremio admin mutations must use the shared persistent rate limiter');
assert(/router\.post\('\/admin\/settings\/stremio\/servers\/:id',stremioMutationLimit,/.test(page),'Server eligibility mutation must apply the Stremio rate limiter');
assert(/router\.post\('\/admin\/settings\/stremio\/runtime',stremioMutationLimit,/.test(page),'Runtime mutation must apply the Stremio rate limiter');
assert(migration.includes("service_type IN ('jellyfin','stremio','bundle')"),'Plan service type constraint is missing');
assert(migration.includes('token_hash TEXT'),'Stremio entitlements must store a token hash field');
assert(!migration.includes('token_plaintext'),'Stremio schema must not introduce plaintext token storage');
assert(migration.includes('service_type_snapshot'),'Subscription service type must be snapshotted');
assert(migration.includes('enforce_stremio_entitlement_integrity'),'Database must enforce Stremio cross-record integrity');
assert(migration.includes('Stremio entitlement customer does not own subscription'),'Subscription/customer ownership mismatch must be rejected');
assert(migration.includes('Stremio Jellyfin account belongs to another customer'),'Jellyfin account/customer ownership mismatch must be rejected');
assert(migration.includes('Stremio Jellyfin account does not belong to assigned server'),'Jellyfin account/server mismatch must be rejected');
assert(runtimeMigration.includes('Active Stremio entitlement is incomplete'),'Runtime migration must require a complete active entitlement including restricted Jellyfin access');
assert(runtimeMigration.includes("'stremio_internal'")&&runtimeMigration.includes('Stremio entitlement requires a dedicated internal Jellyfin account'),'Runtime migration must require and explicitly reject non-internal Jellyfin identities');

console.log('stremio admin runtime smoke: ok');
