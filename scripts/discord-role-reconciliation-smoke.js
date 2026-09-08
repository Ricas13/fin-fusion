'use strict';

const assert = require('assert');
const fs = require('fs');
const reconciliation = require('../src/integrations/discord-role-reconciliation');

async function main() {
    const source = fs.readFileSync('src/integrations/discord-role-reconciliation.js', 'utf8');
    const communications = fs.readFileSync('src/platform/customer-communications.js', 'utf8');
    const provisioning = fs.readFileSync('src/jellyfin/resilient-provisioning.js', 'utf8');
    const roles = fs.readFileSync('src/integrations/discord-roles.js', 'utf8');
    const jobs = fs.readFileSync('src/automation/jobs.js', 'utf8');
    const worker = fs.readFileSync('scripts/automation-worker.js', 'utf8');

    assert.match(communications, /discordRoleReconciliation\.reconcileCustomerDiscordRoles\(req\.session\.customerId\)\.catch\(/,
        'Discord OAuth success must immediately reconcile plan roles without making role sync a link failure');
    assert.match(communications, /Discord connected, but immediate role reconciliation failed:/,
        'best-effort Discord role failure must remain visible to operators');

    assert.match(source, /require\('\.\.\/jellyfin\/resilient-provisioning'\)/,
        'Discord event/sweep reconciliation must reuse the authoritative provisioning reconciler');
    assert.match(provisioning, /deriveCustomerAccessDesiredState\([\s\S]*?\)\.activePlanIds/,
        'Discord desired roles must come from current effective multi-service access');
    assert.match(roles, /const toRemove=\[\.\.\.managed\]\.filter\(id=>current\.has\(id\)&&!desired\.has\(id\)\)/,
        'stale plan-managed roles must be removed when no longer desired');
    assert.match(roles, /const toAdd=\[\.\.\.desired\]\.filter\(id=>!current\.has\(id\)\)/,
        'all desired roles for multiple active plans must be added idempotently');
    assert.doesNotMatch(roles, /current[^\n]*filter[^\n]*toRemove/,
        'role removal must be based on configured managed roles, not arbitrary member roles');

    assert.match(jobs, /async discord_roles\(\)\{return discordRoleReconciliation\.reconcileLinkedCustomers\(\)\}/,
        'persistent automation registry must expose the Discord repair sweep');
    assert.match(worker, /discord_roles:43200/,
        'Discord role repair sweep must default to every 12 hours');

    const calls = [];
    const fakeQuery = async () => ({ rows: [
        { customer_id: 'customer-a' },
        { customer_id: 'customer-b' },
        { customer_id: 'customer-c' }
    ] });
    const fakeReconcile = async customerId => {
        calls.push(customerId);
        if (customerId === 'customer-b') throw new Error('simulated Discord API failure');
        if (customerId === 'customer-c') return { skipped: 'not_guild_member' };
        return { added: ['role-1'], removed: [], errors: [] };
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    let summary;
    try {
        summary = await reconciliation.reconcileLinkedCustomers({ queryFn: fakeQuery, reconcileFn: fakeReconcile });
    } finally {
        console.warn = originalWarn;
    }
    assert.deepStrictEqual(calls, ['customer-a', 'customer-b', 'customer-c'],
        'one customer failure must not stop the rest of the safety sweep');
    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.processed, 3);
    assert.strictEqual(summary.synced, 1);
    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.failures[0].customerId, 'customer-b');

    console.log('Discord role reconciliation smoke passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
