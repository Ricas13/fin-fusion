'use strict';

const assert = require('assert');
const crypto = require('crypto');
const invitations = require('../src/invitations');
const { query, getPool } = require('../src/db');

(async () => {
    const planResult = await query('SELECT id FROM plans WHERE active=TRUE ORDER BY sort_order,name LIMIT 1');
    assert(planResult.rowCount, 'Expected at least one active plan for invitation smoke test');
    const suffix = crypto.randomBytes(5).toString('hex');
    const email = `invite-${suffix}@example.test`;
    const username = `invite_${suffix}`.slice(0, 40);
    const password = `Invitation-${suffix}-Password!`;

    const created = await invitations.createInvitation({
        planId: planResult.rows[0].id,
        email,
        ttlHours: 1,
        singleUse: true,
        actorUserId: null
    });
    assert(created.token && created.token.length > 30, 'Invitation token was not returned');

    const before = await invitations.lookupInvitation(created.token);
    assert(before, 'Invitation could not be looked up');
    assert.strictEqual(before.status, 'pending');
    assert.strictEqual(before.invitedEmail, email);

    const redeemed = await invitations.redeemInvitation({
        token: created.token,
        email,
        username,
        password
    });
    assert(redeemed.user?.id, 'Invitation did not create an app user');
    assert(redeemed.customer?.id, 'Invitation did not create a customer');
    assert.strictEqual(redeemed.subscription?.source, 'invitation');
    assert(redeemed.provisioningError, 'Zero-server smoke environment should leave Jellyfin provisioning pending, not fail account creation');

    const after = await invitations.lookupInvitation(created.token);
    assert.strictEqual(after.status, 'used');

    let replayRejected = false;
    try {
        await invitations.redeemInvitation({ token: created.token, email, username: `${username}2`, password });
    } catch (error) {
        replayRejected = /already been used/i.test(error.message);
    }
    assert(replayRejected, 'Single-use invitation replay was not rejected');

    const row = await query('SELECT source,status FROM subscriptions WHERE id=$1', [redeemed.subscription.id]);
    assert.strictEqual(row.rows[0].source, 'invitation');

    console.log('invitations db smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
