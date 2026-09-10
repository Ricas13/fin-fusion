'use strict';

const assert = require('assert');
const channelLinks = require('../src/integrations/customer-channel-links');

const OLD_DISCORD_ID = '1488947904461799494';
const NEW_DISCORD_ID = '1503480465389260994';
const CUSTOMER_ID = 'customer-discord-relink';

function fakeClient(previousId, events) {
    return {
        async query(sql) {
            if (sql.includes('SELECT discord_user_id FROM customer_communication_preferences')) {
                events.push('read-old-identity');
                return { rowCount: previousId ? 1 : 0, rows: previousId ? [{ discord_user_id: previousId }] : [] };
            }
            if (sql.includes('INSERT INTO customer_communication_preferences')) {
                events.push('write-new-identity');
                return { rowCount: 1, rows: [] };
            }
            if (sql.includes('UPDATE customers SET discord_user_id=')) {
                events.push('mirror-new-identity');
                return { rowCount: 1, rows: [] };
            }
            if (sql.includes("VALUES('customer.discord.relink'")) {
                events.push('audit-relink');
                return { rowCount: 1, rows: [] };
            }
            throw new Error(`Unexpected relink query: ${sql}`);
        }
    };
}

function deps({ previousId = OLD_DISCORD_ID, revokeResult = { errors: [], configurationErrors: [], removed: ['managed-role'] } } = {}) {
    const events = [];
    let syncCalls = 0;
    let tokenConsumed = false;
    const client = fakeClient(previousId, events);

    return {
        events,
        get syncCalls() { return syncCalls; },
        get tokenConsumed() { return tokenConsumed; },
        options: {
            inspectFn: async (raw, channel) => {
                assert.strictEqual(raw, 'valid-token');
                assert.strictEqual(channel, 'discord');
                events.push('inspect-token');
                return { customerId: CUSTOMER_ID };
            },
            withCustomerLock: async (customerId, fn) => {
                assert.strictEqual(customerId, CUSTOMER_ID);
                events.push('lock-customer');
                return fn();
            },
            consumeFn: async (raw, channel, linker) => {
                assert.strictEqual(raw, 'valid-token');
                assert.strictEqual(channel, 'discord');
                events.push('lock-token');
                await linker(client, CUSTOMER_ID);
                tokenConsumed = true;
                events.push('consume-token');
                return { customerId: CUSTOMER_ID };
            },
            syncRolesFn: async (customerId, activePlanIds) => {
                syncCalls += 1;
                assert.strictEqual(customerId, CUSTOMER_ID);
                assert.deepStrictEqual(activePlanIds, [], 'relink must revoke every managed role from the previous Discord member');
                events.push('revoke-old-roles');
                return revokeResult;
            }
        }
    };
}

async function main() {
    const success = deps();
    const linked = await channelLinks.linkDiscord(
        'valid-token',
        { userId: NEW_DISCORD_ID, handle: 'new-user' },
        success.options
    );
    assert.deepStrictEqual(linked, { customerId: CUSTOMER_ID });
    assert.strictEqual(success.syncCalls, 1);
    assert.strictEqual(success.tokenConsumed, true);
    assert.deepStrictEqual(success.events, [
        'inspect-token',
        'lock-customer',
        'lock-token',
        'read-old-identity',
        'revoke-old-roles',
        'write-new-identity',
        'mirror-new-identity',
        'audit-relink',
        'consume-token'
    ], 'old managed roles must be revoked while the old identity is still authoritative and before the relink token is consumed');

    const failed = deps({
        revokeResult: { errors: ['remove managed-role: HTTP 403'], configurationErrors: [] }
    });
    await assert.rejects(
        channelLinks.linkDiscord(
            'valid-token',
            { userId: NEW_DISCORD_ID, handle: 'new-user' },
            failed.options
        ),
        error => error && error.code === 'DISCORD_RELINK_ROLE_REVOKE_FAILED'
    );
    assert.strictEqual(failed.tokenConsumed, false, 'failed old-role revocation must leave the relink token retryable');
    assert.deepStrictEqual(failed.events, [
        'inspect-token',
        'lock-customer',
        'lock-token',
        'read-old-identity',
        'revoke-old-roles'
    ], 'a failed revocation must not overwrite the stored Discord identity');

    const unconfigured = deps({ revokeResult: { skipped: 'not_configured', errors: [], configurationErrors: [] } });
    await assert.rejects(
        channelLinks.linkDiscord(
            'valid-token',
            { userId: NEW_DISCORD_ID },
            unconfigured.options
        ),
        error => error && error.code === 'DISCORD_RELINK_ROLE_REVOKE_FAILED'
    );
    assert.strictEqual(unconfigured.tokenConsumed, false, 'relink must fail closed when Discord role management is unavailable');

    const sameIdentity = deps({ previousId: NEW_DISCORD_ID });
    await channelLinks.linkDiscord(
        'valid-token',
        { userId: NEW_DISCORD_ID, handle: 'renamed-user' },
        sameIdentity.options
    );
    assert.strictEqual(sameIdentity.syncCalls, 0, 'refreshing the same Discord identity must not remove and re-add its roles');
    assert.strictEqual(sameIdentity.tokenConsumed, true);
    assert.deepStrictEqual(sameIdentity.events, [
        'inspect-token',
        'lock-customer',
        'lock-token',
        'read-old-identity',
        'write-new-identity',
        'mirror-new-identity',
        'consume-token'
    ]);

    console.log('Discord relink role revocation smoke passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
