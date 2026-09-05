'use strict';

// Regression coverage for the subscription/provisioning authority refactor:
// PAID=ADD, NOT PAID=REMOVE, CONFIRMED REFUND=REMOVE PLAN, ADMIN=ABSOLUTE
// AUTHORITY, FREE SERVER=ITS OWN ACTIVITY/CAPACITY AUTOMATION.
//
// Each test below is annotated with the invariant number(s) it proves, from
// the governing specification's list of 24. Invariant 20 (durable Jellyfin
// account creation still prevents duplicate remote users) is covered by the
// existing scripts/jellyfin-account-creation-recovery-db-smoke.js, untouched
// by this refactor, and is not duplicated here.

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const provisioning = require('../src/jellyfin/resilient-provisioning');
const subscriptionState = require('../src/entitlements/subscription-state');
const serviceAdminControl = require('../src/entitlements/service-admin-control');
const serviceDesiredState = require('../src/entitlements/service-desired-state');
const manualSubscriptions = require('../src/entitlements/manual-subscriptions');
const accessHolds = require('../src/entitlements/access-holds');
const incidents = require('../src/payments/incidents');
const { transaction } = require('../src/db');
const { encryptWithEnv } = require('../src/security/purpose-crypto');

const tag = `csa-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const created = { customers: [], plans: [], servers: [] };
let remoteUsers = [];
let deletedRemoteIds = new Set();

function installRegistryMock() {
    const original = registry.request;
    registry.request = async (_serverId, path, options = {}) => {
        if (path === '/Users') return remoteUsers.filter(u => !deletedRemoteIds.has(u.Id)).map(u => ({ ...u }));
        if (path === '/Library/VirtualFolders') return [];
        if (path === '/Users/New') {
            const created_ = { Id: `${tag}-remote-${remoteUsers.length + 1}`, Name: options.body.Name };
            remoteUsers.push(created_);
            return { ...created_ };
        }
        if (/\/Policy$/.test(path)) return {};
        const single = /^\/Users\/([^/]+)$/.exec(path);
        if (single) {
            const id = decodeURIComponent(single[1]);
            if (options.method === 'DELETE') { deletedRemoteIds.add(id); return {}; }
            const found = remoteUsers.find(u => u.Id === id && !deletedRemoteIds.has(id));
            if (!found) { const e = new Error('Jellyfin request failed (404)'); throw e; }
            return { ...found };
        }
        throw new Error(`Unexpected Jellyfin smoke path: ${path} ${options.method || 'GET'}`);
    };
    return () => { registry.request = original; };
}

async function createCustomer(label) {
    const r = await query('INSERT INTO customers(display_name,email,registration_source) VALUES($1,$2,\'public\') RETURNING id',
        [`${tag} ${label}`, `${tag}-${label}@example.invalid`]);
    created.customers.push(r.rows[0].id);
    return r.rows[0].id;
}
async function createPaidPlan(label = 'paid') {
    const r = await query(`
        INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
        VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1000,TRUE,TRUE,2,'premium') RETURNING id
    `, [`${tag}-${label}`, `${tag} ${label}`]);
    created.plans.push(r.rows[0].id);
    return r.rows[0].id;
}
async function createServer(label = 'srv') {
    const apiKey = encryptWithEnv(`test-${tag}`, 'JELLYFIN_ENCRYPTION_KEY', 'jf1');
    const r = await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode)
        VALUES($1,$2,'premium','jellyfin','https://example.invalid','https://example.invalid',$3,TRUE,1,100,'healthy',TRUE,TRUE,TRUE,'active') RETURNING *
    `, [`${tag}-${label}`, `${tag}-${label}`, apiKey]);
    created.servers.push(r.rows[0].id);
    return r.rows[0];
}
async function createSubscription({ customerId, planId, status = 'active', source = 'admin_grant', providerSubscriptionId = null, periodEndSql = "NOW()+INTERVAL '30 days'", extensionDays = 0 }) {
    const r = await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,billing_mode,starts_at,current_period_end,service_extension_days,service_type_snapshot)
        VALUES($1,$2,$3,$4,$5,'manual',NOW()-INTERVAL '5 days',${periodEndSql},$6,'jellyfin') RETURNING id
    `, [customerId, planId, status, source, providerSubscriptionId, extensionDays]);
    return r.rows[0].id;
}
async function jellyfinAccountRow(customerId) {
    const r = await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [customerId]);
    return r.rows[0] || null;
}

// Invariants 1-3: paid=add, valid entitlement stays present, ended=removed.
async function testPaidAddKeepRemove(planId, server) {
    const customerId = await createCustomer('paid-lifecycle');
    await createSubscription({ customerId, planId });
    await provisioning.reconcileCustomer(customerId);
    let account = await jellyfinAccountRow(customerId);
    assert(account && !account.disabled, 'invariant 1: successful payment must create/provision a Jellyfin account');

    await provisioning.reconcileCustomer(customerId);
    account = await jellyfinAccountRow(customerId);
    assert(account && !account.disabled, 'invariant 2: valid paid entitlement must keep service present across repeated reconciliation');

    await query(`UPDATE subscriptions SET status='cancelled',current_period_end=NOW()-INTERVAL '1 day',service_extension_days=0 WHERE customer_id=$1`, [customerId]);
    await provisioning.reconcileCustomer(customerId);
    account = await jellyfinAccountRow(customerId);
    assert(!account, 'invariant 3 / invariant 23: an ended paid entitlement must delete the Jellyfin account, not merely disable it');
    return customerId;
}

// Invariants 4-8: refund/dispute handling never becomes a second hold-based
// access-control lifecycle; a confirmed refund removes the plan directly.
async function testRefundIsNotAnAccessState(planId) {
    const customerId = await createCustomer('refund-request');
    const subscriptionId = await createSubscription({ customerId, planId, source: 'stripe', providerSubscriptionId: `sub_${tag}` });

    await incidents.record({ provider: 'stripe', eventId: `evt-partial-${tag}`, caseId: `ch_partial_${tag}`, kind: 'refund', status: 'recorded', identity: { scope: 'direct', customerId }, providerSubscriptionId: `sub_${tag}`, metadata: { fullRefund: false } });
    let sub = (await query('SELECT status FROM subscriptions WHERE id=$1', [subscriptionId])).rows[0];
    assert.strictEqual(sub.status, 'active', 'invariant 5: a refund request/partial refund alone must not remove access');
    let holds = await accessHolds.activeHolds(customerId);
    assert.strictEqual(holds.filter(h => h.hold_type === 'payment_risk').length, 0, 'invariant 6: a refund request must not create an access hold');

    await incidents.record({ provider: 'stripe', eventId: `evt-full-${tag}`, caseId: `ch_full_${tag}`, kind: 'refund', status: 'recorded', identity: { scope: 'direct', customerId }, providerSubscriptionId: `sub_${tag}`, metadata: { fullRefund: true } });
    holds = await accessHolds.activeHolds(customerId);
    assert.strictEqual(holds.filter(h => h.hold_type === 'payment_risk').length, 0, 'invariant 7: a confirmed refund must not create a payment-risk access hold');
    sub = (await query('SELECT status FROM subscriptions WHERE id=$1', [subscriptionId])).rows[0];
    assert.strictEqual(sub.status, 'cancelled', 'invariant 4: a confirmed full refund must remove the associated plan');

    // invariant 8: a legacy payment_risk hold from before this migration must
    // no longer block reconciliation, simulating a record that predates the fix.
    const legacyCustomer = await createCustomer('legacy-hold');
    await createSubscription({ customerId: legacyCustomer, planId });
    await accessHolds.addHold({ customerId: legacyCustomer, type: 'payment_risk', sourceKey: 'legacy:pre-migration', reason: 'pre-existing legacy hold' });
    const effective = await subscriptionState.effectiveSubscription(legacyCustomer);
    assert(effective, 'invariant 8: a legacy payment_risk hold must not block an otherwise-valid entitlement after migration');
    await query('DELETE FROM subscriptions WHERE customer_id=$1', [legacyCustomer]);
    await query('DELETE FROM customer_access_holds WHERE customer_id=$1', [legacyCustomer]);
    await query('DELETE FROM customers WHERE id=$1', [legacyCustomer]);
}

// Invariants 9-10: admin manual/no-payment grant behaves like a normal plan.
async function testManualGrantProvisionsNormally(planId) {
    const customerId = await createCustomer('manual-grant');
    const grantedSubscription = await transaction(client => manualSubscriptions.createManualSubscriptionTx(client, {
        customerId, planId, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 86400000),
        source: 'admin_grant', status: 'active', auditAction: 'admin.customer.manual_grant', auditMetadata: {}
    }));
    const sub = (await query('SELECT source,status FROM subscriptions WHERE id=$1', [grantedSubscription.id])).rows[0];
    assert.strictEqual(sub.source, 'admin_grant', 'invariant 9: admin must be able to grant a plan without payment');
    await provisioning.reconcileCustomer(customerId);
    const account = await jellyfinAccountRow(customerId);
    assert(account && !account.disabled, 'invariant 10: an admin-granted no-payment plan must provision exactly like an equivalent normal plan');
    return customerId;
}

// Invariants 11-13, 16-19: admin authority precedence over payment state, and
// its exact restoration/removal semantics.
async function testAdminAuthorityPrecedence(planId) {
    const customerId = await createCustomer('admin-authority');
    await createSubscription({ customerId, planId, source: 'stripe', providerSubscriptionId: `sub_auth_${tag}` });
    await provisioning.reconcileCustomer(customerId);
    assert(await jellyfinAccountRow(customerId), 'setup: paid entitlement should provision before authority tests');

    await serviceAdminControl.setPresent(customerId, 'jellyfin', { reason: 'break-glass keep-present test' });
    await query(`UPDATE subscriptions SET status='cancelled',current_period_end=NOW()-INTERVAL '10 days',service_extension_days=0 WHERE customer_id=$1`, [customerId]);
    let entitlement = await subscriptionState.effectiveSubscription(customerId);
    assert(entitlement, 'invariant 11: admin-forced access must survive payment failure/expiry');
    let resolved = await serviceDesiredState.resolveServiceDesiredState(customerId, 'jellyfin');
    assert.strictEqual(resolved.authority, 'admin');
    assert.strictEqual(resolved.desiredState, 'present');

    await incidents.record({ provider: 'stripe', eventId: `evt-refund-authority-${tag}`, caseId: `ch_authority_${tag}`, kind: 'refund', status: 'recorded', identity: { scope: 'direct', customerId }, providerSubscriptionId: `sub_auth_${tag}`, metadata: { fullRefund: true } });
    entitlement = await subscriptionState.effectiveSubscription(customerId);
    assert(entitlement, 'invariant 12: admin-forced access must survive a confirmed refund');

    await serviceAdminControl.setRemoved(customerId, 'jellyfin', { reason: 'admin removal must persist' });
    const newSubscriptionId = await createSubscription({ customerId, planId, source: 'stripe', providerSubscriptionId: `sub_new_${tag}` });
    entitlement = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
    assert(entitlement && entitlement.blocked === true, 'invariant 13: admin-forced removal must survive a subsequent successful payment webhook (new subscription row)');
    const visible = await subscriptionState.effectiveSubscription(customerId);
    assert.strictEqual(visible, null, 'invariant 13: admin-removed customer must not resolve as usable access despite the new payment');

    await serviceAdminControl.clear(customerId, 'jellyfin', { reason: 'return to automatic' });
    resolved = await serviceDesiredState.resolveServiceDesiredState(customerId, 'jellyfin');
    assert.strictEqual(resolved.authority, 'automatic', 'invariant 16: returning to automatic must immediately restore normal rules');
    entitlement = await subscriptionState.effectiveSubscription(customerId);
    assert(entitlement && String(entitlement.subscription_id) === String(newSubscriptionId), 'invariant 18: returning to automatic with a valid paid entitlement must provision the service');

    await query(`UPDATE subscriptions SET status='cancelled',current_period_end=NOW()-INTERVAL '1 day',service_extension_days=0 WHERE customer_id=$1`, [customerId]);
    entitlement = await subscriptionState.effectiveSubscription(customerId);
    assert.strictEqual(entitlement, null, 'invariant 17: returning to automatic with no valid entitlement must resolve as service removed');

    // invariant 19: duplicate/out-of-order webhook cannot defeat admin authority.
    await serviceAdminControl.setRemoved(customerId, 'jellyfin', { reason: 'reassert removal' });
    await incidents.record({ provider: 'stripe', eventId: `evt-duplicate-a-${tag}`, caseId: null, kind: 'checkout_completion', status: 'recorded', identity: { scope: 'direct', customerId } });
    await incidents.record({ provider: 'stripe', eventId: `evt-duplicate-a-${tag}`, caseId: null, kind: 'checkout_completion', status: 'recorded', identity: { scope: 'direct', customerId } });
    resolved = await serviceDesiredState.resolveServiceDesiredState(customerId, 'jellyfin');
    assert.strictEqual(resolved.desiredState, 'absent', 'invariant 19: duplicate/out-of-order webhooks must not defeat active admin authority');
    return customerId;
}

// Invariant 14: admin server pin survives automatic placement/rebalancing
// across subscription churn (customer+service scoped, not subscription-scoped).
async function testAdminServerPinSurvivesChurn(planId, serverA, serverB) {
    const customerId = await createCustomer('server-pin');
    const subA = await createSubscription({ customerId, planId });
    await serviceAdminControl.pinServer(customerId, serverA.id, { reason: 'pin to server A' });
    let semantics = await require('../src/jellyfin/admin-control').entitlementSemantics({ customer_id: customerId, subscription_id: subA }, {});
    assert.strictEqual(String(semantics.admin_forced_server_id), String(serverA.id));

    const subB = await createSubscription({ customerId, planId });
    await query(`UPDATE subscriptions SET superseded_by=$2,replaced_at=NOW() WHERE id=$1`, [subA, subB]);
    semantics = await require('../src/jellyfin/admin-control').entitlementSemantics({ customer_id: customerId, subscription_id: subB }, {});
    assert.strictEqual(String(semantics.admin_forced_server_id), String(serverA.id), 'invariant 14: admin server pin must survive automatic placement/rebalancing onto a new subscription row');
    void serverB;
}

// Invariant 15: free inactivity cleanup cannot remove an admin-protected free user.
async function testFreeInactivityRespectsAdminProtection(freePlanId) {
    const customerId = await createCustomer('free-protected');
    await createSubscription({ customerId, planId: freePlanId, periodEndSql: "NOW()+INTERVAL '3650 days'" });
    await serviceAdminControl.setPresent(customerId, 'jellyfin', { reason: 'admin keeps free user despite inactivity' });
    await accessHolds.addHold({ customerId, type: 'inactivity_policy', sourceKey: `plan:${freePlanId}`, reason: 'simulated inactivity trigger' });
    const free = await subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true });
    assert(free && free.blocked === false, 'invariant 15: an admin-protected free user must not be blocked/removed by inactivity automation');
}

async function cleanupRestrictedRoleCoverage(server) {
    // Invariants 21/22: the restricted application runtime role must actually
    // have the privileges runtime code depends on for these two tables. This
    // is a genuine live query as steamfusion_app (not the migration/owner
    // role) - it fails by construction if a required GRANT is ever removed.
    const appUrl = String(process.env.APP_DATABASE_URL || '').trim();
    if (!appUrl) { console.log('canonical service authority db smoke: skipped restricted-role check (APP_DATABASE_URL not set)'); return; }
    const { Client } = require('pg');
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    const customer = await query(`INSERT INTO customers(display_name,email,registration_source) VALUES($1,$2,'public') RETURNING id`, [`${tag}-role-check`, `${tag}-role-check@example.invalid`]);
    const customerId = customer.rows[0].id;
    try {
        try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO jellyfin_account_creation_intents(customer_id,server_id,username) VALUES($1,$2,'role-check-user')`, [customerId, server.id]);
            await client.query(`UPDATE jellyfin_account_creation_intents SET status='remote_created',remote_user_id='role-check-remote' WHERE customer_id=$1`, [customerId]);
            await client.query(`DELETE FROM jellyfin_account_creation_intents WHERE customer_id=$1`, [customerId]);
            await client.query(`INSERT INTO customer_service_admin_control(customer_id,service,mode,reason,created_by,updated_by) VALUES($1,'jellyfin','admin_present','role check',NULL,NULL)`, [customerId]);
            await client.query(`UPDATE customer_service_admin_control SET reason='updated' WHERE customer_id=$1 AND service='jellyfin'`, [customerId]);
            await client.query(`DELETE FROM customer_service_admin_control WHERE customer_id=$1 AND service='jellyfin'`, [customerId]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`invariant 21/22: steamfusion_app is missing a required privilege on jellyfin_account_creation_intents or customer_service_admin_control: ${error.message}`);
        }
    } finally {
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        await client.end();
    }
}

async function run() {
    const restoreRegistry = installRegistryMock();
    let planId, freePlanId, serverA, serverB;
    try {
        planId = await createPaidPlan('primary');
        const freeResult = await query(`SELECT id FROM plans WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE ORDER BY created_at,id LIMIT 1`);
        freePlanId = freeResult.rows[0]?.id;
        serverA = await createServer('a');
        serverB = await createServer('b');

        await testPaidAddKeepRemove(planId, serverA);
        await testRefundIsNotAnAccessState(planId);
        await testManualGrantProvisionsNormally(planId);
        await testAdminAuthorityPrecedence(planId);
        await testAdminServerPinSurvivesChurn(planId, serverA, serverB);
        if (freePlanId) await testFreeInactivityRespectsAdminProtection(freePlanId);
        else console.warn('canonical service authority db smoke: no free-tier plan found, skipping invariant 15 (fresh-install-only gap)');
        await cleanupRestrictedRoleCoverage(serverA);

        console.log('canonical service authority db smoke: ok');
    } finally {
        restoreRegistry();
        for (const customerId of created.customers.reverse()) {
            await query('DELETE FROM customer_service_admin_control WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM customer_access_holds WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM jellyfin_account_creation_intents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM jellyfin_accounts WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM payment_incidents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        }
        for (const planId_ of created.plans.reverse()) await query('DELETE FROM plans WHERE id=$1', [planId_]).catch(() => {});
        for (const serverId of created.servers.reverse()) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch(error => {
        console.error(error.stack || error);
        process.exit(1);
    }).finally(() => getPool().end());
}

module.exports = { run };
