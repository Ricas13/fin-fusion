'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const shell=read('src/platform/admin-html-core.js');
const shellBase=read('src/platform/admin-html-core-base.js');
const capability=read('public/css/admin-capability.css');
const capabilityBase=read('public/css/admin-capability-base.css');
const controls=read('public/css/admin-setting-controls.css');
const providerControls=read('public/css/admin-provider-controls.css');
const controlRenderer=read('src/platform/admin-setting-controls.js');
const enhancer=read('public/js/admin-setting-controls.js');
const settings=read('src/platform/admin-original-settings.js');
const notifications=read('src/platform/admin-notification-preferences.js');
const personalNotifications=read('src/platform/admin-personal-notification-preferences-v2.js');
const plans=read('src/platform/admin-plans.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const abuse=read('src/platform/admin-abuse-protection.js');
const automation=read('src/platform/admin-automation.js');
const payments=read('src/platform/admin-payment-settings.js');
const requestUsers=read('src/platform/admin-request-users.js');
const stremioAdmin=read('src/platform/admin-stremio-sources.js');
const indexLock=read('src/stremio/index-lock.js');
const managedLibraries=read('src/stremio/managed-library-selection.js');
const managedIndex=read('src/stremio/media-index.js');
const externalIndex=read('src/stremio/source-index.js');
const sourcePool=read('src/stremio/source-pool.js');

assert(shell.includes("require('./admin-html-core-base')"),'admin shell must wrap the stable base layout');
assert(shell.includes('/js/admin-setting-controls.js'),'compact setting enhancer must load on every admin page');
assert(shellBase.includes('/css/admin-capability.css'),'base admin shell must load the shared capability stylesheet');
assert(capability.includes("@import url('/css/admin-capability-base.css')")&&capability.includes("@import url('/css/admin-setting-controls.css')")&&capability.includes("@import url('/css/admin-provider-controls.css')"),'capability entrypoint must load layout, setting-control and provider-disclosure layers');
assert(capabilityBase.includes('.capabilityPage')&&capabilityBase.includes('.capabilityLibraryGrid'),'capability-page layout must remain available');

for(const token of ['.settingToggleGrid','.settingToggleInput','.settingSwitchInput','.settingInlineSwitch','.settingSecretDisclosure','.settingChannelDisclosure','.settingEventDisclosure','.booleanMatrix','.notificationIdentityGrid'])assert(controls.includes(token),`shared setting CSS missing ${token}`);
assert(providerControls.includes('.settingProviderDisclosure')&&providerControls.includes('.settingProviderBody'),'provider/integration configuration must use the shared summary/expand philosophy');
assert(controlRenderer.includes('function toggle(')&&controlRenderer.includes('function grid(')&&controlRenderer.includes('function switchInput(')&&controlRenderer.includes('function configured('),'server-rendered settings must have reusable boolean/credential helpers');
assert(enhancer.includes("label.toggleRow, label.checkRow")&&enhancer.includes("label.inlineToggle")&&enhancer.includes(".toggleGrid"),'legacy boolean controls must be promoted into the shared setting language');
assert(enhancer.includes('/admin/notifications/preferences')&&enhancer.includes('/admin/profile/notifications'),'global and personal notification matrices must use shared switch behavior');
assert(enhancer.includes('compactGlobalNotificationChannels')&&enhancer.includes('settingChannelDisclosure'),'global messaging credentials must collapse behind compact channel rows');
assert(enhancer.includes('compactConfiguredSecrets')&&enhancer.includes('settingSecretDisclosure'),'configured password/API-key inputs must collapse to state-first credential rows');
assert(enhancer.includes('input[type="checkbox"][name^="clear"]')&&enhancer.includes('.inlineHelp, .fieldHelp, .settings-hint'),'configured-secret disclosure must carry clear controls and helper copy with the hidden secret field');
assert(enhancer.includes('compactNotificationEventGroups')&&enhancer.includes('settingEventDisclosure'),'notification event catalogues must collapse by job/group until editing');
assert(enhancer.includes('compactPaymentProviders')&&enhancer.includes('settingProviderDisclosure'),'Stripe/PayPal setup must collapse to provider status rows until editing');
assert(enhancer.includes('compactRequestService')&&enhancer.includes('request-service-config'),'Request Service setup must collapse to a status/configure row ahead of daily operations');

assert(settings.includes('class="toggleRow"'),'general/security settings must remain discoverable by the compatibility upgrader while migration is in progress');
assert(!settings.includes('name="requireEmailVerification"'),'public registration email verification is mandatory and must not be exposed as a dead checkbox');
assert(settings.includes('Public registration · verified email required')&&settings.includes('Email verification is mandatory for public registration.'),'registration settings must describe the mandatory verification contract directly');
assert(settings.includes("if(publicRegistration){const mail=await emailSettings.status()")&&settings.includes("saveSetting('platform',{publicRegistration,requireEmailVerification:true}"),'enabling public registration must require transactional email and persist the compatibility flag as true');
assert(plans.includes('class="toggleGrid"')&&plans.includes('class="toggleRow"'),'existing plan boolean policy must feed the canonical toggle grid');
assert(/class="[^"]*\btoggleGrid\b[^"]*"/.test(planCreate)&&planCreate.includes('class="toggleRow"'),'new-plan boolean policy must use the same canonical toggle grid, with optional layout modifiers');
assert(abuse.includes("require('./admin-setting-controls')")&&abuse.includes('settingControls.grid'),'Abuse Protection must be a direct consumer of the canonical server-rendered setting controls');
assert(abuse.includes('clearTurnstileSecret')&&abuse.includes('Configured — leave blank to keep'),'configured Turnstile secrets must be eligible for global credential disclosure');
assert(automation.includes('class="checkRow"')&&automation.includes('name="enabled"'),'automation enabled flags must feed the canonical boolean language');
assert(payments.includes('providerConfigDetails(req,provider,status,url)')&&payments.includes("providerHealthCard(req,'stripe'")&&payments.includes("providerHealthCard(req,'paypal'")&&payments.includes("providerHealthCard(req,'plisio'")&&payments.includes('Configured — leave blank to keep current value'),'all active payment providers and configured secrets must remain discoverable through the shared inline configuration path');
assert(payments.includes('name="payment-provider-config"'),'payment provider configuration must use one exclusive native disclosure group');
assert(requestUsers.includes('action="/admin/request-users/settings"')&&requestUsers.includes('Configured — leave blank to keep current key'),'Request Service must expose a discoverable configuration form and state-preserving API-key field');
assert(notifications.includes('telegramEnabled')&&notifications.includes('discordEnabled')&&notifications.includes('whatsappEnabled'),'global notification channel booleans must remain connected to persisted settings');
assert(personalNotifications.includes('notificationEventGroup')&&personalNotifications.includes('type="checkbox"'),'personal event routing must remain a boolean matrix for the shared enhancer');

assert(indexLock.includes("INDEX_JOB_KEY='captainfin:stremio_media_index'")&&indexLock.includes('pg_try_advisory_xact_lock(hashtext($1))'),'manual Stremio index maintenance must use the same advisory key as the singleton worker');
assert(indexLock.includes('RESTORE_MAINTENANCE_LOCK')&&indexLock.includes('pg_advisory_xact_lock_shared'),'manual Stremio maintenance must preserve the database restore-maintenance lock contract');
assert(managedLibraries.includes('prepareSave')&&managedLibraries.includes('writePrepared'),'managed library changes must support validation before the locked transaction and persistence inside it');
assert(managedIndex.includes("require('./index-lock')")&&managedIndex.includes('indexLock.withIndexTransaction'),'managed index clear/rebuild must be serialized against scheduled indexing on one DB connection');
assert(managedIndex.includes('saveLibrariesAndReset')&&managedIndex.includes('managedLibraries.writePrepared'),'managed library selection and index reset must commit in one locked transaction');
assert(stremioAdmin.includes('managedMediaIndex.saveLibrariesAndReset')&&!stremioAdmin.includes('managedLibraries.save(req.params.id,req.body.libraryId,req.session.authUserId);await managedMediaIndex.clearAndReset'),'managed-library route must not reintroduce the old save-then-clear race');
assert(externalIndex.includes("require('./index-lock')")&&externalIndex.includes('indexLock.withIndexTransaction'),'external index clear/rebuild must be serialized against scheduled indexing on one DB connection');
assert(sourcePool.includes("require('./index-lock')")&&sourcePool.includes('indexLock.withIndexTransaction'),'external library selection changes must use the same Stremio worker lock');
assert(sourcePool.includes("VALUES($1,'queued',NOW(),TRUE,$2,NULL,NOW())")&&sourcePool.includes('deletedItems:Number(deleted.rowCount||0)'),'external library selection must remove deselected rows and queue a full reconcile atomically');
assert(externalIndex.includes('JOIN stremio_source_libraries l ON l.source_id=i.source_id AND l.library_id=i.library_id AND l.selected=TRUE AND l.available=TRUE'),'external runtime lookup must fail closed for deselected or unavailable libraries even if stale rows exist');
assert(!controls.includes('font-size:8px')&&!controls.includes('font-size:9px'),'shared toggle system must not achieve density by shrinking normal setting labels');

console.log('admin settings coherence smoke: ok');
