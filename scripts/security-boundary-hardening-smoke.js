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
