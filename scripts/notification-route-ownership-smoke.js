'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const globalModule = read('src/platform/admin-notification-preferences.js');
const personalModule = read('src/platform/admin-personal-notification-preferences-v2.js');

assert(globalModule.includes("router.use('/admin/notifications/preferences', gate, noStore)"), 'Global notification router must guard the global notification URL space');
assert(!globalModule.includes("router.use('/admin/profile/notifications'"), 'Global notification router must not own personal notification URLs');
assert(!globalModule.includes("router.get('/admin/profile/notifications'"), 'Global notification router must not render the personal notifications page');
assert(!globalModule.includes("router.post('/admin/profile/notifications'"), 'Global notification router must not mutate personal notification preferences');
assert(!globalModule.includes("require('../integrations/admin-channel-links')"), 'Global notification module must not own personal channel-link state');
assert(!globalModule.includes("require('./reporting-currency')"), 'Global notification module must not own personal reporting-currency settings');
assert(globalModule.includes("page: profilePage") && globalModule.includes("data: adminProfileData"), 'Legacy personal exports must delegate to the canonical personal module');

for (const route of [
    "r.get('/admin/profile/notifications'",
    "r.post('/admin/profile/notifications'",
    "r.post('/admin/profile/notifications/telegram/start'",
    "r.post('/admin/profile/notifications/telegram/unlink'",
    "r.post('/admin/profile/notifications/discord/start'",
    "r.get('/admin/profile/notifications/discord/callback'",
    "r.post('/admin/profile/notifications/discord/unlink'",
    "r.post('/admin/profile/notifications/whatsapp'"
]) {
    assert(personalModule.includes(route), `Canonical personal notification router is missing ${route}`);
}

assert(personalModule.includes("adminLinks.inspect(state,'discord')"), 'Canonical Discord OAuth callback must inspect link state before exchanging the code');
assert(personalModule.includes("String(pending.adminUserId)!==String(req.session.authUserId)"), 'Canonical Discord OAuth callback must bind state to the signed-in administrator');

console.log('notification route ownership: ok (global and personal responsibilities are separated)');
