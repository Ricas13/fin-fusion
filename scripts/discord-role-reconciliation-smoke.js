'use strict';

const assert = require('assert');
const fs = require('fs');
const reconciliation = require('../src/integrations/discord-role-reconciliation');
const discordRoles = require('../src/integrations/discord-roles');

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
        'immediate Discord API failures must wake the persistent reconciliation worker');
    assert.match(source, /configurationErrors/,
        'missing or ambiguous plan role configuration must be visible to the safety sweep');
    assert.match(provisioning, /deriveCustomerAccessDesiredState\([\s\S]*?\)\.activePlanIds/,
        'Discord desired roles must come from current effective multi-service access');

    assert.match(roles, /async function planRoleMappings\(/,
        'Discord role resolution must inspect the active plan mappings as a first-class operation');
    assert.match(roles, /function roleFamily\(/,
        'legacy fallback must compare only equivalent plan families');
    assert.match(roles, /familyRoles\.length === 1/,
        'a missing legacy mapping may only fall back when comparable configured plans unanimously identify one role');
    assert.match(roles, /inferredMappings/,
        'fallback role resolution must remain observable rather than silently pretending to be a direct mapping');
    assert.match(roles, /const toAdd = \[\.\.\.desired\]\.filter\(id => !current\.has\(id\)\)/,
        'all resolved desired roles must be added idempotently');
    assert.match(roles, /const toRemove = mappings\.configurationErrors\.length[\s\S]*?\[\.\.\.managed\]\.filter\(id => current\.has\(id\) && !desired\.has\(id\)\)/,
        'stale roles may be removed only when every active plan role is unambiguous');

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

    const legacyPlanId = '11111111-1111-4111-8111-111111111111';
    const paidJellyfinRole = '1488947904461799494';
    const otherPaidJellyfinRole = '1503480465389260994';
    const legacyPlan = {
        id: legacyPlanId,
        name: 'Legacy Yearly - 3 Streams',
        code: 'legacy_3_streams_yearly_40',
        discord_role_id: null,
        service_type: 'jellyfin',
        is_free_tier: false,
        billing_interval: 'year'
    };

    const unanimousQuery = async sql => {
        if (sql.includes('id=ANY')) return { rows: [legacyPlan] };
        if (sql.includes('archived_at IS NULL')) return { rows: [
            {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Monthly',
                code: 'monthly',
                discord_role_id: paidJellyfinRole,
                service_type: 'jellyfin',
                is_free_tier: false,
                billing_interval: 'month'
            },
            {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'Yearly',
                code: 'yearly',
                discord_role_id: paidJellyfinRole,
                service_type: 'jellyfin',
                is_free_tier: false,
                billing_interval: 'year'
            }
        ] };
        throw new Error(`Unexpected role-mapping query: ${sql}`);
    };

    const inferred = await discordRoles.planRoleMappings([legacyPlanId], { queryFn: unanimousQuery });
    assert.deepStrictEqual([...inferred.desiredRoleIds], [paidJellyfinRole],
        'a legacy plan with no direct mapping must inherit the unanimous role configured on comparable paid Jellyfin plans');
    assert.strictEqual(inferred.inferredMappings.length, 1);
    assert.strictEqual(inferred.inferredMappings[0].planName, 'Legacy Yearly - 3 Streams');
    assert.deepStrictEqual(inferred.configurationErrors, []);

    const ambiguousQuery = async sql => {
        if (sql.includes('id=ANY')) return { rows: [legacyPlan] };
        if (sql.includes('archived_at IS NULL')) return { rows: [
            {
                id: '22222222-2222-4222-8222-222222222222',
                discord_role_id: paidJellyfinRole,
                service_type: 'jellyfin',
                is_free_tier: false,
                billing_interval: 'month'
            },
            {
                id: '44444444-4444-4444-8444-444444444444',
                discord_role_id: otherPaidJellyfinRole,
                service_type: 'jellyfin',
                is_free_tier: false,
                billing_interval: 'year'
            }
        ] };
        throw new Error(`Unexpected role-mapping query: ${sql}`);
    };

    const ambiguous = await discordRoles.planRoleMappings([legacyPlanId], { queryFn: ambiguousQuery });
    assert.deepStrictEqual([...ambiguous.desiredRoleIds], [],
        'an ambiguous plan family must never guess which Discord role to assign');
    assert.strictEqual(ambiguous.configurationErrors.length, 1);
    assert.match(ambiguous.configurationErrors[0], /multiple Discord roles/);

    const directRoleId = '1544281036915998770';
    const directQuery = async sql => {
        if (!sql.includes('id=ANY')) throw new Error('Direct mappings must not need a family fallback query.');
        return { rows: [{
            ...legacyPlan,
            discord_role_id: directRoleId
        }] };
    };
    const direct = await discordRoles.planRoleMappings([legacyPlanId], { queryFn: directQuery });
    assert.deepStrictEqual([...direct.desiredRoleIds], [directRoleId],
        'an explicit role configured on the active plan must always beat fallback inference');
    assert.strictEqual(direct.directMappings.length, 1);
    assert.strictEqual(direct.inferredMappings.length, 0);

    const calls = [];
    const fakeQuery = async () => ({ rows: [
        { customer_id: 'customer-a' },
        { customer_id: 'customer-b' },
        { customer_id: 'customer-c' },
        { customer_id: 'customer-d' },
        { customer_id: 'customer-e' }
    ] });
    const fakeReconcile = async customerId => {
        calls.push(customerId);
        if (customerId === 'customer-b') throw new Error('simulated Discord API failure');
        if (customerId === 'customer-c') return { skipped: 'not_guild_member' };
        if (customerId === 'customer-d') return { added: [], removed: [], errors: ['add role-2: HTTP 403'] };
        if (customerId === 'customer-e') return {
            added: [],
            removed: [],
            errors: [],
            configurationErrors: ['Discord role mapping missing for active plan Legacy Yearly - 3 Streams.']
        };
        return { added: ['role-1'], removed: [], errors: [], configurationErrors: [] };
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    let summary;
    try {
        summary = await reconciliation.reconcileLinkedCustomers({ queryFn: fakeQuery, reconcileFn: fakeReconcile });
    } finally {
        console.warn = originalWarn;
    }

    assert.deepStrictEqual(calls, ['customer-a', 'customer-b', 'customer-c', 'customer-d', 'customer-e'],
        'one customer failure must not stop the rest of the safety sweep');
    assert.strictEqual(summary.total, 5);
    assert.strictEqual(summary.processed, 5);
    assert.strictEqual(summary.synced, 1);
    assert.strictEqual(summary.skipped, 1);
    assert.strictEqual(summary.failed, 3);
    assert.strictEqual(summary.failures[0].customerId, 'customer-b');
    assert.strictEqual(summary.failures[1].customerId, 'customer-d');
    assert.strictEqual(summary.failures[2].customerId, 'customer-e');
    assert.match(summary.warning, /simulated Discord API failure/,
        'degraded worker runs must expose a useful warning so job health retries them');

    console.log('Discord role reconciliation smoke passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
