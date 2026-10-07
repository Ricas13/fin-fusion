'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const planExternal=read('src/stremio/plan-external-sources.js');
const externalRuntime=read('src/stremio/external-direct-runtime.js');
const runtime=read('src/stremio/runtime.js');
const admin=read('src/platform/admin-plan-delivery.js');
const readiness=read('src/platform/product-readiness.js');
const sourcePool=read('src/stremio/source-pool.js');

assert(planExternal.includes('JOIN plan_stremio_sources ps'),'external runtime sources must come from explicit plan mappings');
assert(planExternal.includes('i.last_completed_at IS NOT NULL')&&planExternal.includes('i.item_count>0'),'selected external sources must have a completed serving snapshot, even while a newer refresh is queued or running');
assert((planExternal.match(/s\.password_encrypted IS NOT NULL/g)||[]).length>=3,'single-plan, all-plan, and runtime external readiness must all require credentials capable of minting isolated playback sessions');
assert(!planExternal.includes('SELECT s.*,s.priority plan_priority FROM stremio_sources'),'explicit plan source helper must not fall back to every external source');
assert(externalRuntime.includes("require('./plan-external-sources')"),'external stream generation must use explicit plan source composition');
assert(externalRuntime.includes('planExternalSources.forEntitlement(entitlement)'),'external stream generation must not implicitly add unselected sources');
assert(!runtime.includes("require('./plan-external-sources')"),'protocol runtime must not own external source authorization after relay retirement');
assert(runtime.includes("const retiredPlayback = (_req, res) => res.status(410).end();")&&runtime.includes("router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId', retiredPlayback)"),'legacy external CAPTAiNFiN proxy URLs must remain retired with 410');
assert(!externalRuntime.includes('controlPlaybackUrl'),'external stream results must not be wrapped in a CAPTAiNFiN playback control hop');
assert(externalRuntime.includes("require('./external-playback-token')"),'external raw playback must use isolated entitlement playback sessions');
assert(externalRuntime.includes('externalPlaybackToken.tokenFor(source,entitlement,{returnContext:true})'),'external stream generation must mint or reuse an entitlement-isolated upstream playback token and receive the locked current source context');
assert(/url\s*:\s*directPlaybackUrl\(\{source:currentSource,itemId:item\.Id,mediaSourceId:media\.Id,container:media\.Container,filename:file,accessToken\}\)/.test(externalRuntime),'external stream results must contain the provider raw-file URL directly from the locked current source using the isolated playback token');
assert(externalRuntime.includes('[RAW_EXTERNAL_STREAM]:true'),'external raw streams must be tagged internally so response middleware leaves the provider URL untouched');
assert(/url\.searchParams\.set\(\s*['"]Static['"]\s*,\s*['"]true['"]\s*\)/.test(externalRuntime),'external direct playback must request static/original media bytes');
assert(/url\.searchParams\.set\(\s*['"]api_key['"]\s*,\s*token\s*\)/.test(externalRuntime),'external direct playback URL must carry the isolated entitlement playback token to the provider');
assert(!externalRuntime.includes("url.searchParams.set('api_key',client.sourceToken(source))"),'external customer-visible raw URLs must never expose the durable source-maintenance token');
assert(externalRuntime.includes('source.media_server_type'),'external direct playback must route through the source provider discriminator');

assert(admin.includes('Managed Jellyfin sources are always returned first'),'plan UI must state managed-first composition');
assert(admin.includes('Optional external sources'),'plan UI must present external sources as additions');
assert(admin.includes('Leaving every external source unchecked is valid'),'plan UI must support managed-only plans');
assert(admin.includes('no external source is implicitly added'),'plan UI must explain explicit external selection');
assert(admin.includes('Preconfiguration only:'),'Jellyfin-only plans must be able to preconfigure Stremio sources before switching delivery');
assert(admin.includes('${sourceSection}'),'source composition must remain visible regardless of current delivery type');
assert(!admin.includes('Selecting at least one source removes the managed-server fallback'),'old replacement/fallback wording must be removed');
assert(!admin.includes("throw new Error('Select at least one Stremio source.')"),'saving zero external sources must be valid');
assert(admin.includes('sourcePool.savePlanSources(req.params.id,selections'),'admin must persist an empty selection as no external additions');
assert(sourcePool.includes('const rows=Array.isArray(selections)?selections:[]'),'canonical plan-source writer must accept an empty external selection');
assert(sourcePool.includes('operationLock.withLock(`stremio-plan:${planId}`')&&sourcePool.includes('externalPlaybackToken.revokeUnauthorizedForPlan(planId)'),'plan-source mutations must serialize with raw session issuance through authorization change and cleanup');

assert(readiness.includes('eligibleManagedServers:checks.eligibleServers'),'plan readiness must distinguish usable managed servers from raw server counts');
assert(readiness.includes('managedReadyIndexes:checks.managedReadyIndexes'),'plan readiness must retain managed index state');
assert(readiness.includes('managedReady=managedPlanReady(resolved)'),'plan readiness must evaluate managed delivery independently');
assert(readiness.includes('externalReady=sourceState.ready>0'),'plan readiness must evaluate only selected ready external sources');
assert(readiness.includes('if(!managedReady&&!externalReady)'),'a Stremio plan must require either managed readiness or a selected ready external source');
assert(!readiness.includes('sourceState.mapped>0&&sourceState.ready<1'),'failed optional external additions must not block a healthy managed primary path');

console.log('stremio plan source composition smoke: ok');
