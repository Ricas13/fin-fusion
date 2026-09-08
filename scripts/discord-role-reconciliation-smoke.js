'use strict';

const assert = require('assert');
const fs = require('fs');
const reconciliation = require('../src/integrations/discord-role-reconciliation');

async function main() {
    const source = fs.readFileSync('src/integrations/discord-role-reconciliation.js', 'utf8');
    const communications = fs.readFileSync('src/platform/customer-communications.js', 'utf8');
    const provisioning = fs.readFileSync('src/jellyfin/resilient-provisioning.js', 'utf8');
    const roles = fs.readFileSync('src/integrations/discord-roles.js', 'utf8');
    const channelLinks = fs.readFileSync('src/integrations/customer-channel-links.js', 'utf8');
    const customer360 = fs.readFileSync('src/platform/customer-360.js', 'utf8');
    const identityGuard = fs.readFileSync('src/platform/admin-discord-identity-guard.js', 'utf8');
    const identityUi = fs.readFileSync('public/js/admin-discord-identity.js', 'utf8');
    const composition = fs.readFileSync('src/platform/admin-route-composition.js', 'utf8');
    const adminHtml = fs.readFileSync('src/platform/admin-html.js', 'utf8');
    const jobs = fs.readFileSync('src/automation/jobs.js', 'utf8');
    const worker = fs.readFileSync('scripts/automation-worker.js', 'utf8');

    assert.match(communications, /discordRoleReconciliation\.reconcileCustomerDiscordRoles\(req\.session\.customerId\)\.catch\(/,
        'Discord OAuth success must immediately reconcile plan roles without making role sync a link failure');
    assert.match(communications, /Discord connected, but immediate role reconciliation failed:/,
        'best-effort Discord role failure must remain visible to operators');

    assert.match(source, /require\('\.\.\/jellyfin\/resilient-provisioning'\)/,
        'Discord event/sweep reconciliation must reuse the authoritative provisioning reconciler');
    assert.match(source, /requestRoleRetry\(\)/,
        'immediate Discord role failures must wake the persistent reconciliation worker');
    assert.match(provisioning, /deriveCustomerAccessDesiredState\([\s\S]*?\)\.activePlanIds/,
        'Discord desired roles must come from current effective multi-service access');
    assert.match(roles, /SELECT DISTINCT discord_role_id FROM plans WHERE id=ANY\(\$1::uuid\[\]\)/,
        'Discord role selection must come directly from role IDs configured on active plans');
    assert.match(roles, /const toRemove=\[\.\.\.managed\]\.filter\(id=>current\.has\(id\)&&!desired\.has\(id\)\)/,
        'stale plan-managed roles must be removed when no longer desired');
    assert.match(roles, /const toAdd=\[\.\.\.desired\]\.filter\(id=>!current\.has\(id\)\)/,
        'all desired roles for multiple active plans must be added idempotently');
    assert.doesNotMatch(roles, /current[^\n]*filter[^\n]*toRemove/,
        'role removal must be based on configured managed roles, not arbitrary member roles');

    assert.match(channelLinks, /UPDATE customers SET discord_user_id=\$2,discord_username=\$3/,
        'verified Discord OAuth identity must keep legacy customer fields synchronized for compatibility');
    assert.match(customer360, /prefs\.discord_user_id AS linked_discord_user_id/,
        'Customer 360 must read Discord identity from verified communication preferences');
    assert.match(customer360, /customer\.discord_user_id=customer\.linked_discord_user_id\|\|null/,
        'legacy Customer 360 fields must be compatibility aliases of the verified link');
    assert.match(identityGuard, /req\.body\.discordUserId = identity\.userId \|\| ''/,
        'admin profile posts must not be able to override the verified Discord user ID');
    assert.match(identityGuard, /req\.body\.discordUsername = identity\.username \|\| ''/,
        'admin profile posts must not be able to override the verified Discord username');
    assert.match(identityGuard, /router\.use\('\/admin\/users\/:customerId'/,
        'the Discord invariant guard must run as pre-write middleware rather than owning customer mutation routes');
    assert.doesNotMatch(identityGuard, /router\.post\('/,
        'the Discord identity guard must never duplicate canonical admin POST route ownership');
    assert.match(identityGuard, /req\.path === '\/profile' \|\| req\.path === '\/manage\/account'/,
        'the pre-write guard must be limited to the two legacy customer identity writers');
    assert.match(composition, /createAdminDiscordIdentityGuardRouter\(\)/,
        'the Discord identity guard must be mounted before customer profile writers');
    assert.match(identityUi, /input\.readOnly = true/,
        'Discord identity fields must be visibly read-only in admin customer editing');
    assert.match(adminHtml, /\/js\/admin-discord-identity\.js/,
        'admin pages must load the Discord identity read-only controller');

    assert.match(jobs, /async discord_roles\(\)\{return discordRoleReconciliation\.reconcileLinkedCustomers\(\)\}/,
        'persistent automation registry must expose the Discord repair sweep');
    assert.match(worker, /discord_roles:43200/,
        'Discord role repair sweep must default to every 12 hours');

    const calls = [];
    const fakeQuery = async () => ({ rows: [
        { customer_id: 'customer-a' },
        { customer_id: 'customer-b' },
        { customer_id: 'customer-c' },
        { customer_id: 'customer-d' }
    ] });
    const fakeReconcile = async customerId => {
        calls.push(customerId);
        if (customerId === 'customer-b') throw new Error('simulated Discord API failure');
        if (customerId === 'customer-c') return { skipped: 'not_guild_member' };
        if (customerId === 'customer-d') return { added: [], removed: [], errors: ['add role-2: HTTP 403'] };
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
    assert.deepStrictEqual(calls, ['customer-a', 'customer-b', 'customer-c', 'customer-d'],
        'one customer failure must not stop the rest of the safety sweep');
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.processed, 4);
    assert.strictEqual(summary.synced, 1);
    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(summary.failed, 2);
    assert.strictEqual(summary.failures[0].customerId, 'customer-b');
    assert.strictEqual(summary.failures[1].customerId, 'customer-d');
    assert.match(summary.warning, /simulated Discord API failure/,
        'degraded worker runs must expose a useful warning so job health retries them');

    console.log('Discord role reconciliation smoke passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
