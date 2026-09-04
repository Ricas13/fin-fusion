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
const createBrowser=read('public/js/admin-plan-create-v2.js');
const inventory=read('src/platform/admin-plan-inventory.js');
const serverForm=read('views/admin/server-form.ejs');
const onboarding=read('views/customer/onboarding.ejs');
const storefront=read('src/platform/storefront.js');
const capacitySource=read('src/entitlements/plan-capacity.js');
const userCapacitySource=read('src/jellyfin/user-capacity.js');
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

// Jellyfin plans no longer own an inventory number. Server max_users is the
// only customer-capacity input, with exactly one managed customer per place.
assert(create.includes('name="capacityLimit" required'),'legacy plan storage field must remain available for compatible plan creation');
assert(createBrowser.includes("if(availability)availability.hidden=!stremio")&&createBrowser.includes("if(jellyfin)capacityLimit.value='0'"),'Jellyfin plan creation must hide the duplicate plan inventory field and keep it neutral internally');
assert(inventory.includes("usage.model==='fleet_users'")&&inventory.includes('One managed Jellyfin customer = one place'),'Jellyfin plan inventory must be derived from server user capacity');
assert(inventory.includes('managed users:')&&inventory.includes('customers still owed an account:')&&inventory.includes('temporary reservations:'),'Jellyfin availability must explain managed, owed and held customer places');
assert(!inventory.includes('server stream capacity')&&!inventory.includes('Fleet stream capacity')&&!inventory.includes('Sold / held streams'),'admin plan inventory must not expose retired stream-weighted capacity language');
assert(serverForm.includes('Customer capacity')&&serverForm.includes('Every Jellyfin customer uses exactly one place'),'server configuration must define max_users as customer-user capacity');
assert(!serverForm.includes('Sellable stream capacity')&&!serverForm.includes('3-stream plan consumes'),'server configuration must not describe capacity as stream inventory');
assert(capacitySource.includes("return'fleet_users'")&&capacitySource.includes('managedUsers')&&capacitySource.includes('pendingUsers')&&capacitySource.includes('reservedUsers'),'Jellyfin fleet availability must be expressed only in customer places');
assert(!capacitySource.includes("commercial_snapshot->'streams'")&&!capacitySource.includes('streamLimit')&&!capacitySource.includes('streamUsed')&&!capacitySource.includes('jellyfin_server_metrics'),'capacity must not depend on plan streams or raw Jellyfin total-user metrics');
assert(userCapacitySource.includes('COUNT(DISTINCT ja.customer_id)')&&userCapacitySource.includes("ja.account_purpose='jellyfin'")&&userCapacitySource.includes('ja.disabled=FALSE'),'canonical server capacity must count enabled managed customer users exactly once');
assert(capacitySource.includes("key=model==='fleet_users'?`fleet-users:${serverClass(plan)||'unclassified'}`"),'all Jellyfin plans sharing a server class must serialize acquisition against the same user-capacity lock');
assert(capacitySource.includes("health_status IN('healthy','degraded')")&&capacitySource.includes("COALESCE(js.placement_mode,'active')='active'")&&capacitySource.includes('configured_servers'),'server user capacity must still honor automatic placement health/state');
assert(plansList.includes("state.model==='fleet_users'")&&plansList.includes('View server user capacity'),'Plans must display server user capacity rather than stream inventory');
assert(lifecycle.includes("capacity.acquisitionSql('p')")&&lifecycle.includes('capacity.lockAndAssert(client,plan.id'),'payment/free/trial acquisition must retain the SQL prefilter plus locked authoritative capacity recheck');
assert(/capacity_limit IS NULL\)\s+OR\s+\(capacity_limit >= 0\)|capacity_limit IS NULL OR capacity_limit >= 0/.test(migration),'database constraint must continue to admit explicit zero capacity for non-Jellyfin/manual inventory');
assert.strictEqual(capacity.capacityModel({service_type:'jellyfin',server_class:'free'}),'fleet_users');
assert.strictEqual(capacity.capacityModel({service_type:'jellyfin',server_class:'premium'}),'fleet_users');
assert.strictEqual(capacity.capacityModel({service_type:'jellyfin',server_class:'custom'}),'fleet_users','custom Jellyfin plans must also derive capacity from their servers');
assert.strictEqual(capacity.capacityModel({service_type:'bundle',server_class:'custom'}),'fleet_users','bundle plans containing Jellyfin must derive capacity from servers');

// Stremio remains a separate household-unit product and is not part of the
// Jellyfin user-capacity simplification.
assert(inventory.includes('Stremio availability is presented as customer places')&&inventory.includes('larger household variants consume more'),'Stremio household capacity must remain explicit');
assert(capacitySource.includes("commercial_snapshot->'stremioHouseholdNetworkLimit'")&&capacitySource.includes('async function stremioHouseholdUsage'),'Stremio usage must keep household-unit accounting');

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
assert(storefront.includes('sectionAvailability')&&storefront.includes('state?.label'),'public storefront must use the authoritative capacity scarcity label');
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
  const fakeManualDb=async sql=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'zero-plan',capacity_limit:0,service_type:'legacy',server_class:null}]};
    if(sql.includes('AS used'))return{rowCount:1,rows:[{used:0,reserved:0}]};
    throw new Error(`Unexpected manual capacity query: ${sql.slice(0,120)}`);
  };
  const zero=await capacity.usage('zero-plan',fakeManualDb);
  assert.strictEqual(zero.limit,0,'zero must remain an explicit numeric capacity for manual/non-Jellyfin inventory');
  assert.strictEqual(zero.remaining,0);
  assert.strictEqual(zero.soldOut,true);
  await assert.rejects(()=>capacity.assertAvailable('zero-plan',{db:fakeManualDb}),/sold out/i);

  const acquisition=capacity.acquisitionSql('p');
  assert(acquisition.includes('SUM(capacity_server.max_users)'),'fleet SQL must derive capacity from server max_users');
  assert(acquisition.includes('COUNT(DISTINCT capacity_account.customer_id)'),'fleet SQL must count one enabled managed customer per server');
  assert(acquisition.includes('pending_subscription.customer_id'),'fleet SQL must reserve one place for already-entitled customers still awaiting an account');
  assert(acquisition.includes('capacity_free_hold.consumed_at IS NULL')&&acquisition.includes('capacity_free_hold.released_at IS NULL'),'fleet SQL must count pending Free Access registration holds');
  assert(!acquisition.includes("commercial_snapshot->'streams'")&&!acquisition.includes('GREATEST(1,COALESCE(p.streams,1))'),'fleet SQL must never weight capacity by concurrent-stream allowance');
  assert(acquisition.includes('plan_server_eligibility capacity_restriction')&&acquisition.includes('plan_server_eligibility capacity_match'),'fleet SQL must honor explicit plan-server eligibility');
  assert(acquisition.includes("setting_value->>'placementHealthMode'")&&acquisition.includes("capacity_server.placement_mode,'active'"),'fleet SQL must use current placement health/state');

  const unavailableFleetDb=async(sql)=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'fleet-plan',capacity_limit:99,service_type:'jellyfin',server_class:'premium',billing_interval:'month',price_minor:600,is_free_tier:false}]};
    if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
    if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,user_limit:0,managed_users:0}]};
    if(sql.includes('AS pending_users'))return{rowCount:1,rows:[{pending_users:0}]};
    if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
    if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
    throw new Error(`Unexpected fleet capacity query: ${sql.slice(0,120)}`);
  };
  const unavailable=await capacity.usage('fleet-plan',unavailableFleetDb);
  assert.strictEqual(unavailable.model,'fleet_users');
  assert.strictEqual(unavailable.userLimit,0);
  assert.strictEqual(unavailable.remaining,0);
  assert.strictEqual(unavailable.soldOut,true,'drained/unavailable fleet must close acquisition instead of falling back to plans.capacity_limit');

  const occupiedFleetDb=async(sql)=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'occupied-free',capacity_limit:null,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true}]};
    if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
    if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,user_limit:10,managed_users:7}]};
    if(sql.includes('AS pending_users'))return{rowCount:1,rows:[{pending_users:2}]};
    if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
    if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{reserved_users:1}]};
    throw new Error(`Unexpected occupied fleet query: ${sql.slice(0,120)}`);
  };
  const occupied=await capacity.usage('occupied-free',occupiedFleetDb);
  assert.strictEqual(occupied.managedUsers,7);
  assert.strictEqual(occupied.pendingUsers,2);
  assert.strictEqual(occupied.reservedUsers,1);
  assert.strictEqual(occupied.remaining,0,'7 managed + 2 owed + 1 held must fill a 10-user server pool');
  assert.strictEqual(occupied.soldOut,true);

  assert.deepStrictEqual(capacity.scarcity({remaining:2,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'🔥 Only 2 Premium places left',kind:'urgent'});
  assert.deepStrictEqual(capacity.scarcity({remaining:8,soldOut:false,pool:'free',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Only 8 Free places left',kind:'limited'});
  assert.deepStrictEqual(capacity.scarcity({remaining:42,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Available',kind:'available'});

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
  assert.strictEqual(firstStatus.created,1);
  assert.strictEqual(firstStatus.remaining,3);
  assert.strictEqual(duplicateStatus.unchanged,true);
  assert.strictEqual(sent.length,1);
  assert.strictEqual(edited.length,0);
  assert.strictEqual(sent[0].allowEveryone,false);
  assert(sent[0].text.includes('3 free places currently available.')&&sent[0].text.split('\n').some(line=>line==='Reserve / Create Free Account: https://portal.example')&&sent[0].text.includes('10 minutes'));
  assert(freePlanQuery.includes('visible=TRUE')&&freePlanQuery.includes("audience IN('direct','both')")&&freePlanQuery.includes('ORDER BY sort_order,price_minor'));
  const fullStatus=await digest.run({settings:digestSettings,usage:async()=>({remaining:0}),send,edit,transactionFn,operationsConfig:{publicBaseUrl:'https://portal.example'}});
  assert.strictEqual(fullStatus.updated,1);
  assert.strictEqual(sent.length,1);
  assert.strictEqual(edited.length,1);
  assert.strictEqual(edited[0].messageId,'987654321098765432');
  assert(edited[0].text.includes('No free places currently available.')&&edited[0].text.includes('10 minutes'));

  const soldPlan={id:'free-plan',name:'Free Server',description:'Free access',service_type:'jellyfin',billing_interval:'month',price_minor:0,streams:1,capacity:{soldOut:true,label:'Currently full',kind:'sold'}};
  const soldWithInvite=storefrontRuntime.freeTierPanel(soldPlan,{logged:false,registrationOpen:true,discordInviteUrl:'https://discord.gg/captainfin'});
  assert(soldWithInvite.includes('href="https://discord.gg/captainfin"')&&soldWithInvite.includes('>Subscribe</a>')&&soldWithInvite.includes('Free Access is full.')&&soldWithInvite.includes('we post when places open'));
  const soldWithoutInvite=storefrontRuntime.freeTierPanel(soldPlan,{logged:false,registrationOpen:true,discordInviteUrl:''});
  assert(soldWithoutInvite.includes('Currently full')&&!soldWithoutInvite.includes('>Subscribe</a>'));
  assert.strictEqual(notificationSettingsRuntime.discordInviteUrl('https://discord.com/invite/captainfin'),'https://discord.com/invite/captainfin');
  assert.throws(()=>notificationSettingsRuntime.discordInviteUrl('https://example.com/invite/captainfin'),/Discord invite URL/);

  console.log('plan capacity, one-user-one-place fleet scarcity and persistent Discord Free Server status smoke: OK');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
