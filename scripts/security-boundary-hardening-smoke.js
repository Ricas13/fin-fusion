'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const transfer = require('../src/platform/configuration-transfer-v2-core');
const activity = require('../src/jellyfin/activity');
const outbound = require('../src/security/outbound-url-policy');
const adminStepUp = require('../src/auth/admin-step-up');

async function main() {
    const legacy = transfer.normalizeV2Plan({ code: 'legacy', streams: 1 }, { streams: null });
    assert.strictEqual(legacy.streams, null, 'pre-modular V2 imports must preserve the legacy null stream sentinel');

    assert.strictEqual(
        activity.effectiveStreamLimit(null),
        null,
        'accounts without an active entitlement must retain the existing no-concurrent-policy behavior'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'household_network', streams: null }),
        null,
        'household-network plans must remain outside concurrent-stream enforcement'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'concurrent_streams', streams: null }),
        1,
        'malformed concurrent-stream plans must fail closed to one stream'
    );
    assert.strictEqual(
        activity.effectiveStreamLimit({ jellyfin_access_model: 'concurrent_streams', streams: 4 }),
        4,
        'valid concurrent-stream limits must be preserved'
    );

    const customers = read('src/customers.js');
    const dummyHash = /const DUMMY_CUSTOMER_PASSWORD_HASH='([^']+)'/.exec(customers)?.[1];
    assert(dummyHash, 'customer authentication must define a fixed dummy bcrypt hash');
    assert(/^\$2[aby]\$12\$/.test(dummyHash), 'dummy login hash must use the same bcrypt cost as customer passwords');
    assert.strictEqual(await bcrypt.compare('definitely-not-the-dummy-password', dummyHash), false, 'dummy bcrypt hash must be valid');
    assert(
        customers.includes('if(!row||!row.active){await bcrypt.compare(password,DUMMY_CUSTOMER_PASSWORD_HASH);return null}'),
        'unknown and inactive customer logins must execute a bcrypt comparison before returning'
    );

    const activation = read('src/auth/account-activation.js');
    assert(activation.includes("require('../security/password-breach')"), 'customer activation must use the shared breach-password service');
    assert(
        activation.includes('await passwordBreach.assertNotBreached(password);const passwordHash=await bcrypt.hash(password,12)'),
        'activation passwords must be screened before hashing and persistence'
    );

    for (const address of ['64:ff9b::a9fe:a9fe', '64:ff9b:1:a9fe:a9:fe00::']) {
        assert.strictEqual(outbound.nat64Ipv4(address), '169.254.169.254', `NAT64 metadata embedding must decode for ${address}`);
        const classification = outbound.classify(address);
        assert(classification.hard && classification.private && /metadata|link-local/.test(classification.reason), `NAT64 metadata embedding must be blocked for ${address}`);
    }

    // Every per-customer admin POST is security-sensitive. New child actions
    // must inherit step-up automatically rather than relying on a route-name list.
    const customerMutationPaths = [
        '/admin/users/00000000-0000-0000-0000-000000000001/manage/account',
        '/admin/users/00000000-0000-0000-0000-000000000001/permanent-access',
        '/admin/users/00000000-0000-0000-0000-000000000001/assign-server',
        '/admin/users/00000000-0000-0000-0000-000000000001/stremio-household/reset'
    ];
    for (const route of customerMutationPaths) {
        assert.strictEqual(adminStepUp.sensitive({ method: 'POST', path: route }), true, `admin step-up must protect ${route}`);
        assert.strictEqual(adminStepUp.sensitive({ method: 'GET', path: route }), false, `admin step-up must not gate read-only GET ${route}`);
    }

    // Service-credit redemption creates a paid entitlement and therefore must
    // obey the same emergency commerce pause and serialized capacity check as
    // provider/free/trial acquisition paths.
    const affiliateCredits = read('src/affiliate-credits.js');
    assert(affiliateCredits.includes("require('./payments/commerce-control')"), 'affiliate redemption must use the commerce freeze control');
    assert(affiliateCredits.includes("require('./entitlements/plan-capacity')"), 'affiliate redemption must use the shared plan-capacity service');
    assert(affiliateCredits.includes('await commerce.assertOpen();'), 'affiliate redemption must fail closed while commerce is paused');
    assert(affiliateCredits.includes("await planCapacity.lockAndAssert(client,plan.id,plan.name||'This plan');"), 'affiliate redemption must serialize and re-check plan capacity');
    assert(
        affiliateCredits.indexOf('await planCapacity.lockAndAssert') < affiliateCredits.indexOf('INSERT INTO subscriptions'),
        'affiliate capacity must be re-checked before the subscription is inserted'
    );

    const abuseProtection = read('src/security/public-abuse-protection.js');
    assert(
        abuseProtection.includes("const { query, transaction } = require('../db');"),
        'public abuse-protection settings must use the shared database transaction helper'
    );
    assert(
        abuseProtection.includes('await transaction(async client => {'),
        'public abuse-protection settings must save inside a database transaction'
    );
    assert(
        abuseProtection.includes('SELECT setting_value FROM platform_settings WHERE setting_key=$1 FOR UPDATE'),
        'public abuse-protection settings must serialize concurrent edits'
    );
    const abuseSaveStart = abuseProtection.indexOf('async function save(');
    const abuseSaveEnd = abuseProtection.indexOf('\nfunction shouldProtect(', abuseSaveStart);
    const abuseSave = abuseProtection.slice(abuseSaveStart, abuseSaveEnd);
    assert(
        (abuseSave.match(/await client\.query\(/g) || []).length >= 3,
        'public abuse-protection settings read, write and audit must share the same transaction client'
    );
    assert(
        abuseSave.indexOf("INSERT INTO platform_settings") < abuseSave.indexOf("INSERT INTO audit_log"),
        'public abuse-protection settings must persist before the audit row within one atomic transaction'
    );

    const roles = read('scripts/configure-runtime-db-roles.js');
    assert((roles.match(/REVOKE UPDATE,DELETE ON audit_log FROM \$\{role\}/g) || []).length >= 2, 'web and automation role refreshes must preserve audit-log append-only privileges');

    const migration = read('db/migrations/036_security_boundary_hardening.sql');
    for (const token of [
        'plans_jellyfin_stream_contract_check',
        'access_network_leases_customer_idx',
        'REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_app',
        'REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_automation'
    ]) {
        assert(migration.includes(token), `security migration is missing ${token}`);
    }

    console.log('security boundary hardening smoke: ok');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
