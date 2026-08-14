'use strict';

const assert = require('assert');
const crypto = require('crypto');
const invitations = require('../src/invitations');
const { query, getPool } = require('../src/db');

(async () => {
    const planResult = await query('SELECT id FROM plans WHERE active=TRUE ORDER BY sort_order,name LIMIT 1');
    assert(planResult.rowCount, 'Expected at least one active plan for invitation smoke test');
    const suffix = crypto.randomBytes(5).toString('hex');
    const password = `Invitation-${suffix}-Password!`;

    const created = await invitations.createInvitation({
        planId: planResult.rows[0].id,
        name: `Smoke ${suffix}`,
        email: null,
        ttlHours: 1,
        maxUses: 2,
        actorUserId: null
    });
    assert(created.token && created.token.length > 30, 'Invitation token was not returned');

    const before = await invitations.lookupInvitation(created.token);
    assert(before, 'Invitation could not be looked up');
    assert.strictEqual(before.status, 'pending');
    assert.strictEqual(before.invitedEmail, null);
    assert.strictEqual(before.maxUses, 2);
    assert.strictEqual(before.remainingUses, 2);

    const adminRows = await invitations.listInvitations();
    const adminRow = adminRows.find(row => row.id === created.invitation.id);
    assert(adminRow, 'Invitation was not present in admin list');
    assert.strictEqual(adminRow.raw_token, created.token, 'Encrypted invitation token was not recoverable for an authenticated admin list');

    const first = await invitations.redeemInvitation({
        token: created.token,
        email: null,
        username: `invite_${suffix}_1`.slice(0, 40),
        password
    });
    assert(first.user?.id, 'First redemption did not create an app user');
    assert(first.customer?.id, 'First redemption did not create a customer');
    assert.strictEqual(first.user.email, null, 'Email should remain optional');
    assert.strictEqual(first.subscription?.source, 'invitation');
    assert(first.provisioningError, 'Zero-server smoke environment should leave Jellyfin provisioning pending, not fail account creation');

    const midway = await invitations.lookupInvitation(created.token);
    assert.strictEqual(midway.status, 'active');
    assert.strictEqual(midway.remainingUses, 1);

    const second = await invitations.redeemInvitation({
        token: created.token,
        email: null,
        username: `invite_${suffix}_2`.slice(0, 40),
        password
    });
    assert(second.user?.id, 'Second redemption did not create an app user');

    const after = await invitations.lookupInvitation(created.token);
    assert.strictEqual(after.status, 'exhausted');
    assert.strictEqual(after.remainingUses, 0);

    let replayRejected = false;
    try {
        await invitations.redeemInvitation({
            token: created.token,
            email: null,
            username: `invite_${suffix}_3`.slice(0, 40),
            password
        });
    } catch (error) {
        replayRejected = /limit of 2 uses/i.test(error.message);
    }
    assert(replayRejected, 'Invitation use-limit exhaustion was not rejected with a clear message');

    const redemptions = await invitations.listRedemptions();
    const createdUsers = redemptions.filter(row => row.invitation_id === created.invitation.id);
    assert.strictEqual(createdUsers.length, 2, 'Created-users history did not record both redemptions');
    assert(createdUsers.every(row => row.invitation_name === `Smoke ${suffix}`), 'Invitation name was not retained in redemption history');

    const row = await query('SELECT source,status FROM subscriptions WHERE id=$1', [first.subscription.id]);
    assert.strictEqual(row.rows[0].source, 'invitation');

    console.log('invitations db smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
