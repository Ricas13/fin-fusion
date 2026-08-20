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
const controlRenderer=read('src/platform/admin-setting-controls.js');
const enhancer=read('public/js/admin-setting-controls.js');
const settings=read('src/platform/admin-original-settings.js');
const notifications=read('src/platform/admin-notification-preferences.js');
const personalNotifications=read('src/platform/admin-personal-notification-preferences-v2.js');
const plans=read('src/platform/admin-plans.js');

assert(shell.includes("require('./admin-html-core-base')"),'admin shell must wrap the stable base layout');
assert(shell.includes('/js/admin-setting-controls.js'),'compact setting enhancer must load on every admin page');
assert(shellBase.includes('/css/admin-capability.css'),'base admin shell must load the shared capability stylesheet');
assert(capability.includes("@import url('/css/admin-capability-base.css')")&&capability.includes("@import url('/css/admin-setting-controls.css')"),'capability entrypoint must load both layout and setting-control layers');
assert(capabilityBase.includes('.capabilityPage')&&capabilityBase.includes('.capabilityLibraryGrid'),'capability-page layout must remain available');

for(const token of ['.settingToggleGrid','.settingToggleInput','.settingSwitchInput','.settingChannelDisclosure','.booleanMatrix'])assert(controls.includes(token),`shared setting CSS missing ${token}`);
assert(controlRenderer.includes('function toggle(')&&controlRenderer.includes('function grid(')&&controlRenderer.includes('function switchInput('),'server-rendered settings must have reusable toggle helpers');
assert(enhancer.includes("label.toggleRow, label.checkRow")&&enhancer.includes(".toggleGrid") ,'legacy boolean controls must be promoted into the shared setting language');
assert(enhancer.includes('/admin/notifications/preferences')&&enhancer.includes('/admin/profile/notifications'),'global and personal notification matrices must use shared switch behavior');
assert(enhancer.includes('compactGlobalNotificationChannels')&&enhancer.includes('settingChannelDisclosure'),'global messaging credentials must collapse behind compact channel rows');

assert(settings.includes('class="toggleRow"'),'general/security settings must remain discoverable by the compatibility upgrader while migration is in progress');
assert(plans.includes('class="toggleGrid"')&&plans.includes('class="toggleRow"'),'plan boolean policy must feed the canonical toggle grid');
assert(notifications.includes('telegramEnabled')&&notifications.includes('discordEnabled')&&notifications.includes('whatsappEnabled'),'global notification channel booleans must remain connected to persisted settings');
assert(personalNotifications.includes('notificationEventGroup')&&personalNotifications.includes('type="checkbox"'),'personal event routing must remain a boolean matrix for the shared enhancer');
assert(!controls.includes('font-size:8px')&&!controls.includes('font-size:9px'),'shared toggle system must not achieve density by shrinking normal setting labels');

console.log('admin settings coherence smoke: ok');
