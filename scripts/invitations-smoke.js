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
assert.strictEqual(invitations.cleanInvitationName('', 'Trial invite'), 'Trial invite');
assert.throws(() => invitations.cleanInvitationName('x'.repeat(121)), /120/);
assert.strictEqual(invitations.normalizeMaxUses('1'), 1);
assert.strictEqual(invitations.normalizeMaxUses('12'), 12);
assert.strictEqual(invitations.normalizeMaxUses(''), null);
assert.strictEqual(invitations.normalizeMaxUses('unlimited'), null);
assert.throws(() => invitations.normalizeMaxUses('0'), /1 and 10,000/);

const future = new Date(Date.now() + 60000);
const past = new Date(Date.now() - 60000);
assert.strictEqual(invitations.statusFor({ expires_at: future, max_uses: 1, use_count: 0 }), 'pending');
assert.strictEqual(invitations.statusFor({ expires_at: future, max_uses: 1, use_count: 1 }), 'used');
assert.strictEqual(invitations.statusFor({ expires_at: future, max_uses: 5, use_count: 2 }), 'active');
assert.strictEqual(invitations.statusFor({ expires_at: future, max_uses: 5, use_count: 5 }), 'exhausted');
assert.strictEqual(invitations.statusFor({ expires_at: future, max_uses: null, single_use: false, use_count: 200 }), 'active');
assert.strictEqual(invitations.remainingUses({ max_uses: 5, use_count: 2 }), 3);
assert.strictEqual(invitations.remainingUses({ max_uses: null, use_count: 2 }), null);
assert.match(invitations.limitReachedMessage({ max_uses: 5, use_count: 5 }), /limit of 5 uses/i);
assert.strictEqual(invitations.statusFor({ expires_at: past, max_uses: 5, use_count: 0 }), 'expired');
assert.strictEqual(invitations.statusFor({ expires_at: future, revoked_at: new Date(), max_uses: 5, use_count: 0 }), 'revoked');

console.log('invitations smoke: ok');
