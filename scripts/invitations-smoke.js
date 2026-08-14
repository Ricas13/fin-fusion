'use strict';

const assert = require('assert');
const invitations = require('../src/invitations');

const token = 'example-invite-token';
assert.strictEqual(invitations.hashToken(token), invitations.hashToken(token));
assert.notStrictEqual(invitations.hashToken(token), token);
assert.strictEqual(invitations.hashToken(token).length, 64);

assert.strictEqual(invitations.cleanEmail(' User@Example.COM '), 'user@example.com');
assert.strictEqual(invitations.cleanEmail('', { required: false }), null);
assert.throws(() => invitations.cleanEmail('not-an-email'), /valid email/i);
assert.strictEqual(invitations.cleanUsername('user.name_1'), 'user.name_1');
assert.throws(() => invitations.cleanUsername('x'), /3-40/);
assert.doesNotThrow(() => invitations.validatePassword('long-enough-password'));
assert.throws(() => invitations.validatePassword('short'), /12/);

const future = new Date(Date.now() + 60000);
const past = new Date(Date.now() - 60000);
assert.strictEqual(invitations.statusFor({ expires_at: future, single_use: true, use_count: 0 }), 'pending');
assert.strictEqual(invitations.statusFor({ expires_at: future, single_use: true, use_count: 1 }), 'used');
assert.strictEqual(invitations.statusFor({ expires_at: future, single_use: false, use_count: 2 }), 'active');
assert.strictEqual(invitations.statusFor({ expires_at: past, single_use: true, use_count: 0 }), 'expired');
assert.strictEqual(invitations.statusFor({ expires_at: future, revoked_at: new Date(), single_use: true, use_count: 0 }), 'revoked');

console.log('invitations smoke: ok');
