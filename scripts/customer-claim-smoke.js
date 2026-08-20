'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const claims = require('../src/customer-claims');

const root = path.join(__dirname, '..');
const claimRoute = fs.readFileSync(path.join(root, 'src/platform/customer-claim.js'), 'utf8');
const operatorExperience = fs.readFileSync(path.join(root, 'public/js/operator-experience.js'), 'utf8');

async function importedCustomer({ name, email, jellyfinUsername, serverName, serverSlug }) {
    const server = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,priority)
        VALUES($1,$2,'premium',$3,'test-encrypted-key',TRUE,100)
        RETURNING id
    `, [serverName, serverSlug, `https://${serverSlug}.example.test`])).rows[0];
    const customer = (await query(`
        INSERT INTO customers(display_name,email,registration_source)
        VALUES($1,$2,'migration') RETURNING id,user_id
    `, [name, email])).rows[0];
    const account = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
        VALUES($1,$2,$3,$4,FALSE,TRUE)
        RETURNING id,jellyfin_user_id,jellyfin_username,disabled,is_primary
    `, [customer.id, server.id, `${jellyfinUsername}-remote-id`, jellyfinUsername])).rows[0];
    return { server, customer, account };
}

(async () => {
    assert(claimRoute.includes('const created = await claims.createClaim'), 'admin claim creation must retain the one-time raw token returned by createClaim');
    assert(claimRoute.includes('req.session.customerClaimFlash') && claimRoute.includes('takeClaimFlash(req)'), 'claim URL must cross the redirect only through a one-time admin session flash');
    assert(claimRoute.includes('delete req.session.customerClaimFlash'), 'one-time claim URL must be deleted when rendered/revoked');
    assert(claimRoute.includes('absoluteUrl(req, `/claim/${encodeURIComponent(created.token)}`)'), 'admin flash must contain the usable full claim URL');
    assert(claimRoute.includes('shown only once') && claimRoute.includes('not stored in plaintext'), 'claim UI must explain the one-time bearer-token boundary');
    assert(!claimRoute.includes('row.raw_token'), 'admin claim table must not pretend a hash-only persisted claim can recover its raw token');
    assert(operatorExperience.includes("'[data-copy-value],[data-copy-link]'"), 'shared admin clipboard handler must support claim link controls');

    const imported = await importedCustomer({
        name: 'Legacy Alice',
        email: 'alice-old@example.test',
        jellyfinUsername: 'LegacyAlice',
        serverName: 'Claim Premium',
        serverSlug: 'claim-premium'
    });

    const beforeAccount = await query(`SELECT * FROM jellyfin_accounts WHERE id=$1`, [imported.account.id]);
    const created = await claims.createClaim({
        customerId: imported.customer.id,
        emailLock: 'alice@example.test',
        ttlHours: 168,
        actorUserId: null
    });
    assert(created.token && created.token.length > 30, 'raw claim token missing');

    const stored = await query(`SELECT token_hash,token_encrypted,email_lock,consumed_at,revoked_at FROM customer_account_claims WHERE id=$1`, [created.claim.id]);
    assert.strictEqual(stored.rows[0].token_hash, claims.hashToken(created.token));
    assert.strictEqual(stored.rows[0].token_encrypted, null, 'claim bearer token must be stored hash-only');
    assert.strictEqual(stored.rows[0].email_lock, 'alice@example.test');

    const lookup = await claims.lookupClaim(created.token);
    assert(lookup, 'active claim lookup failed');
    assert.strictEqual(lookup.status, 'active');
    assert.strictEqual(lookup.suggested_username, 'LegacyAlice');
    assert(String(lookup.server_names).includes('Claim Premium'));

    let wrongEmailRejected = false;
    try {
        await claims.redeemClaim({
            token: created.token,
            username: 'AlicePortal',
            email: 'wrong@example.test',
            password: 'Very-Strong-Portal-Password-2026!'
        });
    } catch (error) {
        wrongEmailRejected = /different email/i.test(error.message);
    }
    assert(wrongEmailRejected, 'email-locked claim accepted a different address');

    const redeemed = await claims.redeemClaim({
        token: created.token,
        username: 'AlicePortal',
        email: 'alice@example.test',
        password: 'Very-Strong-Portal-Password-2026!'
    });
    assert.strictEqual(redeemed.user.username, 'AlicePortal');
    assert.strictEqual(redeemed.user.email, 'alice@example.test');
    assert.strictEqual(String(redeemed.customer.id), String(imported.customer.id), 'claim must attach to existing customer');

    const portalUser = await query(`SELECT id,email,username,password_hash,role,active,email_verified_at FROM app_users WHERE id=$1`, [redeemed.user.id]);
    assert.strictEqual(portalUser.rows[0].role, 'customer');
    assert.strictEqual(portalUser.rows[0].active, true);
    assert(portalUser.rows[0].email_verified_at, 'email-locked claim should create a usable portal identity');
    assert(await bcrypt.compare('Very-Strong-Portal-Password-2026!', portalUser.rows[0].password_hash));

    const customerAfter = await query(`SELECT user_id,email FROM customers WHERE id=$1`, [imported.customer.id]);
    assert.strictEqual(String(customerAfter.rows[0].user_id), String(redeemed.user.id));
    assert.strictEqual(customerAfter.rows[0].email, 'alice@example.test');

    const afterAccount = await query(`SELECT * FROM jellyfin_accounts WHERE id=$1`, [imported.account.id]);
    for (const field of ['jellyfin_user_id', 'jellyfin_username', 'disabled', 'is_primary']) {
        assert.deepStrictEqual(afterAccount.rows[0][field], beforeAccount.rows[0][field], `claim changed Jellyfin field ${field}`);
    }

    const consumed = await claims.lookupClaim(created.token);
    assert.strictEqual(consumed.status, 'claimed');
    let replayRejected = false;
    try {
        await claims.redeemClaim({
            token: created.token,
            username: 'SecondPortal',
            email: 'alice@example.test',
            password: 'Another-Very-Strong-Password-2026!'
        });
    } catch (error) {
        replayRejected = /invalid|expired|already been claimed/i.test(error.message);
    }
    assert(replayRejected, 'claim token replay was not rejected safely');

    const second = await importedCustomer({
        name: 'Legacy Bob',
        email: null,
        jellyfinUsername: 'LegacyBob',
        serverName: 'Claim Secondary',
        serverSlug: 'claim-secondary'
    });
    const firstBobClaim = await claims.createClaim({ customerId: second.customer.id, ttlHours: 72 });
    const rotatedBobClaim = await claims.createClaim({ customerId: second.customer.id, ttlHours: 72 });
    assert.notStrictEqual(firstBobClaim.token, rotatedBobClaim.token);
    const oldBob = await claims.lookupClaim(firstBobClaim.token);
    assert.strictEqual(oldBob.status, 'revoked', 'rotating a claim must revoke the prior link');
    const currentBob = await claims.lookupClaim(rotatedBobClaim.token);
    assert.strictEqual(currentBob.status, 'active');
    await claims.revokeClaim({ claimId: rotatedBobClaim.claim.id });
    assert.strictEqual((await claims.lookupClaim(rotatedBobClaim.token)).status, 'revoked');

    const adminRows = await claims.listAdminClaims();
    const aliceRow = adminRows.find(row => String(row.customer_id) === String(imported.customer.id));
    const bobRow = adminRows.find(row => String(row.customer_id) === String(second.customer.id));
    assert(aliceRow?.user_id, 'claimed customer missing portal identity in admin list');
    assert.strictEqual(aliceRow.claim_status, 'claimed');
    assert.strictEqual(bobRow.claim_status, 'revoked');
    assert.strictEqual(bobRow.raw_token, null, 'revoked raw token must not be exposed to admin UI');

    const audit = await query(`
        SELECT action,metadata FROM audit_log
        WHERE entity_id=$1 AND action LIKE 'customer.claim%'
        ORDER BY created_at
    `, [String(imported.customer.id)]);
    assert(audit.rows.some(row => row.action === 'customer.claim_link.create'));
    const completed = audit.rows.find(row => row.action === 'customer.claim.complete');
    assert(completed, 'claim completion audit event missing');
    assert.strictEqual(completed.metadata.jellyfinPasswordChanged, false);

    console.log('customer claim smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
