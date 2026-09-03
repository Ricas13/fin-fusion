'use strict';

const fs=require('fs');
const assert=require('assert');
const ejs=require('ejs');
const capacity=require('../src/entitlements/plan-capacity');
const digest=require('../src/automation/free-places-digest');
const storefrontRuntime=require('../src/platform/storefront');
const notificationSettingsRuntime=require('../src/integrations/notification-settings');

const read=file=>fs.readFileSync(file,'utf8');
const create=read('src/platform/admin-plan-create-v2.js');
const inventory=read('src/platform/admin-plan-inventory.js');
const serverForm=read('views/admin/server-form.ejs');
const onboarding=read('views/customer/onboarding.ejs');
const storefront=read('src/platform/storefront.js');
const checkoutIntents=read('src/payments/checkout-intents.js');
const capacitySource=read('src/entitlements/plan-capacity.js');
const plansList=read('src/platform/admin-plans-list.js');
const lifecycle=read('src/payments/lifecycle.js');
const notificationSettings=read('src/integrations/notification-settings.js');
const notificationOutbox=read('src/integrations/notification-outbox.js');
const adminNotifications=read('src/platform/admin-notification-preferences.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const dashboard=read('views/customer/dashboard.ejs');
const access=read('views/customer/jellyfin.ejs');
const provisioningHelpers=read('src/jellyfin/provisioning-helpers.js');
const jobs=read('src/automation/jobs.js');
const automationWorker=read('scripts/automation-worker.js');
const inactivity=read('src/automation/customer-inactivity.js')+read('src/automation/customer-inactivity-scoped.js');
const migration=read('db/migrations/000_database_baseline.sql');

assert(/capacityLimit\s*=\s*int\(body\.capacityLimit,\s*0,\s*1000000,\s*'Available slots'\)/.test(create),'new-plan backend must accept zero available slots');
assert(/capacityLimit:\s*input\.capacityLimit\s*\?\?\s*'0'/.test(create),'new plans must default to zero availability');
assert(create.includes('name="capacityLimit" required')&&create.includes('min="0" max="1000000"'),'new-plan browser control must allow zero slots for manual/fallback capacity');
assert(inventory.includes('name="capacityLimit" min="0" max="1000000"'),'manual Availability editor must allow zero slots');
assert(inventory.includes('Maximum simultaneous trials')&&inventory.includes('Stremio household capacity'),'trials and Stremio must retain explicit manual acquisition caps with household-unit semantics');
assert(inventory.includes('Sold / held households')&&inventory.includes('multi-household purchases consume the correct amount'),'Stremio Availability must explain household-unit inventory to administrators');
assert(inventory.includes('controlled by server stream capacity'),'paid/free Jellyfin plan inventory must direct capacity changes to the server fleet');
assert(inventory.includes('Fleet stream capacity')&&inventory.includes('Sold / held streams'),'derived Jellyfin availability must expose the shared stream budget to administrators');
assert(inventory.includes('n<0||n>1000000'),'Availability backend must accept zero and reject negative manual limits');
assert(serverForm.includes('Sellable stream capacity')&&serverForm.includes('A 3-stream plan consumes 3 units'),'server configuration must explain that max_users is the sellable stream-entitlement budget');
assert(capacitySource.includes("commercial_snapshot->'streams'")&&capacitySource.includes('billing_checkout_intents'),'fleet usage must count snapshotted stream entitlements and open checkout holds');
assert(capacitySource.includes("FLEET_OCCUPANT_STATUSES=['active','trialing']")&&capacitySource.includes("FLEET_ACCESS_HOLD_TYPES=['inactivity_policy','jellyfin_cleanup']"),'fleet occupancy must only count active/trialing customers without inactivity or cleanup holds');
assert(capacitySource.includes("commercial_snapshot->'stremioHouseholdNetworkLimit'")&&capacitySource.includes('async function stremioHouseholdUsage'),'Stremio usage must count purchased and held household units');
assert(capacitySource.includes("key=model==='fleet_streams'?`fleet:${serverClass(plan)}`"),'fleet acquisition must serialize against a shared Premium/Free capacity lock');
assert(capacitySource.includes("health_status IN('healthy','degraded')")&&capacitySource.includes("COALESCE(js.placement_mode,'active')='active'")&&capacitySource.includes('configured_servers'),'fleet capacity must follow placement health/state and retain an explicit configured-fleet signal during drain/outage');
assert(checkoutIntents.includes("capacity.lockAndAssert(client,planId")&&checkoutIntents.includes('streams:snapshot.streams')&&checkoutIntents.includes('households:snapshot.stremioHouseholdNetworkLimit'),'checkout must reserve the selected Jellyfin stream or Stremio household capacity atomically');
assert(onboarding.includes('scarcityBadge')&&onboarding.includes('sharedCapacity'),'customer onboarding must surface shared fleet scarcity at the plan-family level');
assert(onboarding.includes("if(sold)")&&onboarding.includes('No new place can be activated until capacity becomes available.'),'sold-out plans must disable acquisition actions in the customer portal');
assert(storefront.includes('sectionAvailability')&&storefront.includes('state?.label'),'public storefront must use the real capacity scarcity label rather than synthetic inventory copy');
assert(lifecycle.includes("capacity.acquisitionSql('p')")&&lifecycle.includes('capacity.lockAndAssert(client,plan.id'),'payment/free/trial acquisition must retain the SQL prefilter plus locked authoritative recheck');
assert(plansList.includes('${used} occupying · ${held} held · ${limit} sellable · ${esc(state.requiredStreams)} per new customer')&&plansList.includes('View shared ${esc(state.pool)} capacity'),'admin plan capacity must show occupants, temporary holds, sellable capacity and per-customer stream weight separately');
assert(/capacity_limit IS NULL\)\s+OR\s+\(capacity_limit >= 0\)|capacity_limit IS NULL OR capacity_limit >= 0/.test(migration),'database constraint must admit explicit zero capacity');

// Discord community settings extend the existing notification_delivery_v1 owner.
assert(notificationSettings.includes('async function sendDiscord(text,{userId=null}={})')&&notificationSettings.includes("discordApi('/users/@me/channels'"),'existing Discord delivery must remain a user-DM flow');
assert(notificationSettings.includes('async function sendDiscordChannel({channelId,text,allowEveryone=false}={})')&&notificationSettings.includes('/channels/${encodeURIComponent(destination)}/messages'),'Discord channel delivery must be a separate explicit primitive');
assert(notificationSettings.includes("allowed_mentions:{parse:allowEveryone?['everyone']:[]}"),'Discord channel delivery must suppress @everyone unless explicitly enabled');
assert(notificationOutbox.includes('enqueueDiscordChannel')&&notificationOutbox.includes('payload?.discordChannel')&&notificationOutbox.includes('settings.sendDiscord(payload?.text||row.message_type,{userId:row.destination})'),'durable channel delivery must coexist with the existing Discord DM outbox path');
assert(adminNotifications.includes('discordInviteUrl')&&adminNotifications.includes('discordFreePlacesDigestEnabled')&&adminNotifications.includes('discordFreePlacesChannelId')&&adminNotifications.includes('discordFreePlacesTimezone')&&adminNotifications.includes('discordFreePlacesTime1')&&adminNotifications.includes('discordFreePlacesTime2')&&adminNotifications.includes('discordFreePlacesMinRemaining')&&adminNotifications.includes('discordFreePlacesMentionEveryone')&&adminNotifications.includes('stremioMetadataAddonUrl'),'Discord community and onboarding fields must live with the existing notification delivery settings');
assert(jobs.includes('free_places_digest')&&automationWorker.includes('free_places_digest:30')&&automationWorker.includes('VALUES($1,TRUE,$2,NOW()) ON CONFLICT(job_key) DO NOTHING')&&automationWorker.includes('DEFAULT_JOB_INTERVALS[jobKey]||300'),'Free Server availability status must be inserted enabled at its 30-second default instead of the generic five-minute interval');
assert(notificationSettings.includes('communityForLoad')&&notificationSettings.includes('extras=communityForLoad'),'persisted incomplete community settings must load without throwing and leave the status updater disabled');
assert(!inactivity.includes('free-places-digest')&&!inactivity.includes('free_places_digest'),'inactivity handling must never post Discord Free Server availability directly');

// /account reuses assigned credentials and private Stremio URLs; media credentials are managed in My Access.
assert(customerDashboard.includes("notificationSettings.status().catch(()=>({}))")&&customerDashboard.includes("discordInviteUrl:deliverySettings.discordInviteUrl||''")&&customerDashboard.includes('stremioMetadataAddonUrl:deliverySettings.stremioMetadataAddonUrl'),'both /account render paths must receive the shared Discord invite and the ready dashboard must receive the optional Stremio metadata addon');
assert(onboarding.includes('isFree&&discordInviteUrl')&&onboarding.includes('Free Access is full.')&&onboarding.includes('>Subscribe</a>')&&onboarding.includes('Currently full'),'logged-in customers without active access must get the Discord Subscribe CTA only for a sold-out Free Server plan');
assert(access.includes('How to sign in')&&access.includes('Install an official <%= player %> app.')&&access.includes('<span>Server URL</span>')&&access.includes('<span>Username</span>')&&access.includes('Use the <%= player %> password you set here.'),'My Access must own official-client, assigned-server, username and chosen-password sign-in guidance for ready Jellyfin and Emby accounts');
assert(dashboard.includes('Access is being prepared.')&&/href="https:\/\/web\.stremio\.com"/.test(dashboard)&&dashboard.includes('Profile → Addons → Add addon')&&dashboard.includes('value="<%= stremioManifestUrl %>"')&&dashboard.includes('stremioMetadataAddonUrl'),'service onboarding must stay on /account, remain pending-aware and use the existing private Stremio manifest with an optional configured metadata addon');
assert(dashboard.includes('Install in Stremio')&&dashboard.includes('Keep this link private.'),'Stremio onboarding must preserve the primary install action and private-link warning');
assert(dashboard.includes('freeSoldOut')&&dashboard.includes('discordInviteUrl')&&dashboard.includes('>Subscribe</a>')&&dashboard.includes('Currently full'),'active-account Free Server card must use the Discord invite only when sold out and configured');
assert(!dashboard.includes('7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club')&&!onboarding.includes('7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club')&&!customerDashboard.includes('7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club'),'Stremio metadata onboarding must never hardcode the retired addon URL');
assert(/Download an official Jellyfin client: https:\/\/jellyfin\.org\/downloads\/\\n2\. Server URL:/.test(provisioningHelpers)&&provisioningHelpers.includes('Use the password you set under Jellyfin access')&&provisioningHelpers.includes('portal_username'),'the existing provisioned email must repeat the same official-client and chosen-password onboarding semantics');
ejs.compile(onboarding,{filename:'views/customer/onboarding.ejs'});
ejs.compile(dashboard,{filename:'views/customer/dashboard.ejs'});
ejs.compile(access,{filename:'views/customer/jellyfin.ejs'});

(async()=>{
  const fakeDb=async()=>({rowCount:1,rows:[{id:'zero-plan',capacity_limit:0,used:0}]});
  const state=await capacity.usage('zero-plan',fakeDb);
  assert.strictEqual(state.limit,0,'zero must remain an explicit numeric capacity');
  assert.strictEqual(state.remaining,0,'zero-capacity plan must report zero remaining');
  assert.strictEqual(state.soldOut,true,'zero-capacity plan must be sold out before any acquisition');
  await assert.rejects(()=>capacity.assertAvailable('zero-plan',{db:fakeDb}),/sold out/i,'zero-capacity plan must reject new acquisition');
  const acquisition=capacity.acquisitionSql('p');
  assert(acquisition.includes('p.capacity_limit IS NULL OR p.capacity_limit >'),'SQL acquisition guard must preserve legacy/manual zero-capacity behavior');
  assert(acquisition.includes('SUM(capacity_server.max_users)')&&acquisition.includes("active_subscription.commercial_snapshot->'streams'")&&acquisition.includes("capacity_checkout.commercial_snapshot->'streams'"),'fleet SQL acquisition must compare eligible stream capacity with active and checkout stream units');
  assert(acquisition.includes("active_subscription.status IN ('active','trialing')")&&acquisition.includes("capacity_access_hold.hold_type IN ('inactivity_policy','jellyfin_cleanup')"),'fleet SQL acquisition must use the same occupant statuses and open-hold exclusion as runtime usage');
  assert(acquisition.includes('capacity_free_hold.consumed_at IS NULL')&&acquisition.includes('capacity_free_hold.released_at IS NULL'),'fleet SQL acquisition must count pending Free Access holds');
  assert(acquisition.includes('GREATEST(1,COALESCE(p.streams,1))'),'fleet SQL acquisition must reserve enough room for the next plan-sized stream entitlement');
  assert(acquisition.includes('plan_server_eligibility capacity_restriction')&&acquisition.includes('plan_server_eligibility capacity_match'),'fleet SQL acquisition must honor plan-specific server eligibility when detecting/configuring capacity');
  assert(acquisition.includes("setting_value->>'placementHealthMode'")&&acquisition.includes("capacity_server.placement_mode,'active'"),'fleet SQL acquisition must use the same health and placement admission signals as runtime capacity');
  assert(acquisition.includes("p.billing_interval<>'trial' OR")&&acquisition.includes('NOT (p.service_type=\'jellyfin\''),'fleet SQL acquisition must retain manual trial/fallback capacity instead of replacing it');
  assert.deepStrictEqual(capacity.scarcity({remaining:2,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'🔥 Only 2 Premium places left',kind:'urgent'},'real Premium scarcity must use exact low inventory');
  assert.deepStrictEqual(capacity.scarcity({remaining:8,soldOut:false,pool:'free',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Only 8 Free places left',kind:'limited'},'real Free scarcity must expose exact inventory below ten');
  assert.deepStrictEqual(capacity.scarcity({remaining:42,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Available',kind:'available'},'large capacity must not expose unnecessary inventory numbers');

  const unavailableFleetDb=async(sql)=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'fleet-plan',capacity_limit:99,service_type:'jellyfin',server_class:'premium',billing_interval:'month',price_minor:600,is_free_tier:false,streams:3}]};
    if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
    if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,stream_limit:0}]};
    if(sql.includes('FROM subscriptions s JOIN plans p'))return{rowCount:1,rows:[{stream_used:0}]};
    if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
    if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
    throw new Error(`Unexpected fleet-capacity query: ${sql.slice(0,120)}`);
  };
  const unavailable=await capacity.usage('fleet-plan',unavailableFleetDb);
  assert.strictEqual(unavailable.model,'fleet_streams','configured fleet must remain the capacity model while temporarily unavailable');
  assert.strictEqual(unavailable.streamLimit,0,'unavailable/drained eligible servers must contribute zero sellable stream capacity');
  assert.strictEqual(unavailable.remaining,0,'unavailable fleet must expose zero places');
  assert.strictEqual(unavailable.soldOut,true,'unavailable fleet must close acquisition instead of falling back to the legacy per-plan limit');

  let occupantSql='',occupantParams=[];
  const occupiedFleetDb=async(sql,params=[])=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'occupied-free',capacity_limit:null,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true,streams:1}]};
    if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
    if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,stream_limit:10}]};
    if(sql.includes('AS stream_used')){occupantSql=sql;occupantParams=params;return{rowCount:1,rows:[{stream_used:2}]};}
    if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:1}]};
    if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:1}]};
    throw new Error(`Unexpected occupied fleet query: ${sql.slice(0,120)}`);
  };
  const occupied=await capacity.usage('occupied-free',occupiedFleetDb);
  assert.strictEqual(occupied.streamUsed,2,'streamUsed must represent current occupants only');
  assert.strictEqual(occupied.streamReserved,2,'checkout and Free Access reservations must remain held separately');
  assert.strictEqual(occupied.streamRemaining,6,'remaining stream capacity must subtract occupants and holds');
  assert(occupantSql.includes('NOT EXISTS(SELECT 1 FROM customer_access_holds h')&&occupantSql.includes('h.released_at IS NULL'),'open access holds must exclude the customer from streamUsed');
  assert.deepStrictEqual(occupantParams,['free',['active','trialing'],['inactivity_policy','jellyfin_cleanup']],'runtime fleet occupancy must bind only occupant statuses and inactivity/cleanup hold types');

  let freePlanQuery='',storedStatus=null;
  const statusClient={query:async(sql,params=[])=>{
    if(sql.includes('pg_advisory_xact_lock'))return{rowCount:1,rows:[{}]};
    if(sql.includes("is_free_tier=TRUE")&&sql.includes("service_type='jellyfin'")){freePlanQuery=sql;return{rowCount:1,rows:[{id:'free-plan'}]};}
    if(sql.includes('SELECT setting_value FROM platform_settings WHERE setting_key=$1'))return storedStatus?{rowCount:1,rows:[{setting_value:storedStatus}]}:{rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO platform_settings(setting_key,setting_value)')){storedStatus=JSON.parse(params[1]);return{rowCount:1,rows:[]};}
    throw new Error(`Unexpected Free Server status query: ${sql.slice(0,120)}`);
  }};
  const transactionFn=async fn=>fn(statusClient);
  const digestSettings={discordFreePlacesDigestEnabled:true,discordConfigured:true,discordFreePlacesChannelId:'123456789012345678',discordFreePlacesTimezone:'UTC',discordFreePlacesTime1:'06:00',discordFreePlacesTime2:'18:00',discordFreePlacesMinRemaining:1,discordFreePlacesMentionEveryone:false};
  const sent=[],edited=[];
  const send=async input=>{sent.push(input);return{id:'987654321098765432'};};
  const edit=async input=>{edited.push(input);return{id:input.messageId};};
  const firstStatus=await digest.run({settings:digestSettings,usage:async()=>({remaining:3}),send,edit,transactionFn,operationsConfig:{publicBaseUrl:'https://portal.example/'}});
  const duplicateStatus=await digest.run({settings:digestSettings,usage:async()=>({remaining:3}),send,edit,transactionFn,operationsConfig:{publicBaseUrl:'https://portal.example/'}});
  assert.strictEqual(firstStatus.created,1,'first live-capacity reconciliation must create the canonical Discord status message');
  assert.strictEqual(firstStatus.remaining,3,'persistent status must report live remaining capacity');
  assert.strictEqual(duplicateStatus.unchanged,true,'unchanged capacity must not edit or append another Discord message');
  assert.strictEqual(sent.length,1,'persistent availability must create exactly one Discord message');
  assert.strictEqual(edited.length,0,'unchanged availability must not issue a redundant PATCH');
  assert.strictEqual(sent[0].allowEveryone,false,'persistent availability must never create @everyone spam');
  assert(sent[0].text.includes('3 free places currently available.')&&sent[0].text.split('\n').some(line=>line==='Reserve / Create Free Account: https://portal.example')&&sent[0].text.includes('10 minutes'),'open status must expose exact remaining places, portal URL and reservation duration');
  assert(freePlanQuery.includes('visible=TRUE')&&freePlanQuery.includes("audience IN('direct','both')")&&freePlanQuery.includes('ORDER BY sort_order,price_minor'),'status updater must choose the same first public Free Server plan as the storefront');
  const fullStatus=await digest.run({settings:digestSettings,usage:async()=>({remaining:0}),send,edit,transactionFn,operationsConfig:{publicBaseUrl:'https://portal.example'}});
  assert.strictEqual(fullStatus.updated,1,'capacity transition to full must edit the existing Discord status');
  assert.strictEqual(sent.length,1,'capacity transition must not append a second Discord message');
  assert.strictEqual(edited.length,1,'capacity transition must PATCH the canonical Discord message once');
  assert.strictEqual(edited[0].messageId,'987654321098765432','capacity transition must edit the stored canonical Discord message ID');
  assert(edited[0].text.includes('No free places currently available.')&&edited[0].text.includes('10 minutes'),'full status must explain both unavailability and automatic hold expiry');

  const soldPlan={id:'free-plan',name:'Free Server',description:'Free access',service_type:'jellyfin',billing_interval:'month',price_minor:0,streams:1,capacity:{soldOut:true,label:'Currently full',kind:'sold'}};
  const soldWithInvite=storefrontRuntime.freeTierPanel(soldPlan,{logged:false,registrationOpen:true,discordInviteUrl:'https://discord.gg/captainfin'});
  assert(soldWithInvite.includes('href="https://discord.gg/captainfin"')&&soldWithInvite.includes('>Subscribe</a>')&&soldWithInvite.includes('Free Access is full.')&&soldWithInvite.includes('we post when places open'),'sold-out logged-out storefront must link directly to the configured Discord community');
  const soldWithoutInvite=storefrontRuntime.freeTierPanel(soldPlan,{logged:false,registrationOpen:true,discordInviteUrl:''});
  assert(soldWithoutInvite.includes('Currently full')&&!soldWithoutInvite.includes('>Subscribe</a>'),'sold-out storefront without an invite must keep the disabled full state');
  assert.strictEqual(notificationSettingsRuntime.discordInviteUrl('https://discord.com/invite/captainfin'),'https://discord.com/invite/captainfin','supported Discord invite URLs must normalize cleanly');
  assert.throws(()=>notificationSettingsRuntime.discordInviteUrl('https://example.com/invite/captainfin'),/Discord invite URL/,'non-Discord invite hosts must be rejected');

  console.log('plan zero-capacity, fleet scarcity and persistent Discord Free Server status smoke: OK');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});