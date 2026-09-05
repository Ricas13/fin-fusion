'use strict';

const fs = require('fs');
const customers = require('../src/customers');

function read(path) {
    return fs.readFileSync(path, 'utf8');
}

function assertMinlengthCount(name, source, expected) {
    const count = (source.match(/minlength="8"/g) || []).length;
    if (count < expected) throw new Error(`${name} exposes ${count} password minimum field(s), expected at least ${expected}`);
}

function assertPolicyText(name, source) {
    if (!source.includes('between 8 and 200 characters') && !source.includes('at least 8 characters')) {
        throw new Error(`${name} does not enforce/report the 8-character password minimum`);
    }
}

async function main() {
    const register = read('views/customer/register.ejs');
    const reset = read('views/customer/reset-password.ejs');
    const security = read('src/platform/customer-security.js');
    const firstRunView = read('views/auth/first-run-setup.ejs');
    const firstRunCore = read('src/auth/first-run-setup.js');
    const activationView = read('src/platform/account-activation-router.js');
    const activationCore = read('src/auth/account-activation.js');
    const adminSecurity = read('views/admin/security-password.ejs');
    const staffAuth = read('src/auth/service-engine.js');
    const customerClaim = read('src/platform/customer-claim.js');
    const accessHub = read('views/customer/jellyfin.ejs');
    const legacyPasswordSync = read('src/platform/customer-password-sync.js');
    const customerJellyfin = read('src/platform/customer-jellyfin.js');
    const adminJellyfin = read('src/platform/admin-customer-jellyfin-password.js');
    const requestSync = read('src/integrations/request-user-sync.js');
    const application = read('src/application.js');
    const bootstrap = read('scripts/bootstrap-admin.js');

    if (!register.includes('name="password" minlength="8"')) {
        throw new Error('Registration form does not expose the 8-character portal password minimum');
    }
    assertMinlengthCount('Password-reset form', reset, 2);
    assertMinlengthCount('Account-security form', security, 2);
    for (const [name, source] of [
        ['First-run setup view', firstRunView],
        ['Activation view', activationView],
        ['Admin security view', adminSecurity],
        ['Customer claim view', customerClaim],
        ['Customer access hub view', accessHub],
        ['Legacy service password form', legacyPasswordSync],
        ['Admin Jellyfin support view', adminJellyfin]
    ]) {
        assertMinlengthCount(name, source, 2);
    }

    for (const [name, source] of [
        ['Customer password core', read('src/customers.js')],
        ['First-run setup core', firstRunCore],
        ['Activation core', activationCore],
        ['Staff password core', staffAuth],
        ['Customer access media password route', customerJellyfin],
        ['Legacy service password route', legacyPasswordSync],
        ['Admin Jellyfin password route', adminJellyfin],
        ['Overseerr request password sync', requestSync],
        ['ADMIN_PASSWORD environment guard', application],
        ['Bootstrap admin command', bootstrap]
    ]) {
        assertPolicyText(name, source);
    }

    let shortRejected = false;
    try {
        await customers.validateNewPassword('Ab1!xy7');
    } catch (error) {
        shortRejected = String(error.message || '').includes('between 8 and 200 characters');
    }
    if (!shortRejected) throw new Error('Seven-character customer password was not rejected by the canonical policy');
    await customers.validateNewPassword('Ab1!xy78');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
