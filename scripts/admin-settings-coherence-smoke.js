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

assert(shell.includes("require('./admin-html-core-base')"),'admin shell must wrap the stable base layout');
assert(shell.includes('/js/admin-setting-controls.js'),'compact setting enhancer must load on every admin page');
assert(shellBase.includes('/css/admin-capability.css'),'base admin shell must load the shared capability stylesheet');
assert(capability.includes("@import url('/css/admin-capability-base.css')")&&capability.includes("@import url('/css/admin-setting-controls.css')")&&capability.includes("@import url('/css/admin-provider-controls.css')"),'capability entrypoint must load layout, setting-control and provider-disclosure layers');
assert(capabilityBase.includes('.capabilityPage')&&capabilityBase.includes('.capabilityLibraryGrid'),'capability-page layout must remain available');

for(const token of ['.settingToggleGrid','.settingToggleInput','.settingSwitchInput','.settingInlineSwitch','.settingSecretDisclosure','.settingChannelDisclosure','.settingEventDisclosure','.booleanMatrix','.notificationIdentityGrid'])assert(controls.includes(token),`shared setting CSS missing ${token}`);
assert(providerControls.includes('.settingProviderDisclosure')&&providerControls.includes('.settingProviderBody'),'payment-provider configuration must use the shared summary/expand philosophy');
assert(controlRenderer.includes('function toggle(')&&controlRenderer.includes('function grid(')&&controlRenderer.includes('function switchInput(')&&controlRenderer.includes('function configured('),'server-rendered settings must have reusable boolean/credential helpers');
assert(enhancer.includes("label.toggleRow, label.checkRow")&&enhancer.includes("label.inlineToggle")&&enhancer.includes(".toggleGrid"),'legacy boolean controls must be promoted into the shared setting language');
assert(enhancer.includes('/admin/notifications/preferences')&&enhancer.includes('/admin/profile/notifications'),'global and personal notification matrices must use shared switch behavior');
assert(enhancer.includes('compactGlobalNotificationChannels')&&enhancer.includes('settingChannelDisclosure'),'global messaging credentials must collapse behind compact channel rows');
assert(enhancer.includes('compactConfiguredSecrets')&&enhancer.includes('settingSecretDisclosure'),'configured password/API-key inputs must collapse to state-first credential rows');
assert(enhancer.includes('compactNotificationEventGroups')&&enhancer.includes('settingEventDisclosure'),'notification event catalogues must collapse by job/group until editing');
assert(enhancer.includes('compactPaymentProviders')&&enhancer.includes('settingProviderDisclosure'),'Stripe/PayPal setup must collapse to provider status rows until editing');

assert(settings.includes('class="toggleRow"'),'general/security settings must remain discoverable by the compatibility upgrader while migration is in progress');
assert(plans.includes('class="toggleGrid"')&&plans.includes('class="toggleRow"'),'existing plan boolean policy must feed the canonical toggle grid');
assert(planCreate.includes('class="toggleGrid"')&&planCreate.includes('class="toggleRow"'),'new-plan boolean policy must use the same canonical toggle grid');
assert(abuse.includes('clearTurnstileSecret')&&abuse.includes('Configured — leave blank to keep'),'configured Turnstile secrets must be eligible for global credential disclosure');
assert(automation.includes('class="checkRow"')&&automation.includes('name="enabled"'),'automation enabled flags must feed the canonical boolean language');
assert(payments.includes('id="stripe-provider"')&&payments.includes('id="paypal-provider"')&&payments.includes('Configured — leave blank to keep current value'),'payment provider cards and configured secrets must remain discoverable by compact enhancement');
assert(notifications.includes('telegramEnabled')&&notifications.includes('discordEnabled')&&notifications.includes('whatsappEnabled'),'global notification channel booleans must remain connected to persisted settings');
assert(personalNotifications.includes('notificationEventGroup')&&personalNotifications.includes('type="checkbox"'),'personal event routing must remain a boolean matrix for the shared enhancer');
assert(!controls.includes('font-size:8px')&&!controls.includes('font-size:9px'),'shared toggle system must not achieve density by shrinking normal setting labels');

console.log('admin settings coherence smoke: ok');
