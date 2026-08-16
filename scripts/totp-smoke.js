'use strict';

const assert = require('assert');
const totp = require('../src/auth/totp');

// RFC 6238 Appendix B SHA1 test secret, encoded as Base32.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const vectors = [
  [59_000, '94287082'],
  [1_111_111_109_000, '07081804'],
  [1_111_111_111_000, '14050471'],
  [1_234_567_890_000, '89005924'],
  [2_000_000_000_000, '69279037'],
  [20_000_000_000_000, '65353130']
];

for (const [time, expected] of vectors) {
  assert.strictEqual(totp.totp(secret, { time, digits: 8 }), expected, `RFC 6238 vector failed at ${time}`);
  assert.strictEqual(totp.verifyTotp(secret, expected, { time, digits: 8, window: 0 }), true, `RFC 6238 verification failed at ${time}`);
}

const generated = totp.generateSecret();
assert.match(generated, /^[A-Z2-7]+$/);
const now = 1_700_000_000_000;
const code = totp.totp(generated, { time: now });
assert.match(code, /^\d{6}$/);
assert.strictEqual(totp.verifyTotp(generated, code, { time: now, window: 0 }), true);
assert.strictEqual(totp.verifyTotp(generated, code, { time: now + 30_000, window: 1 }), true, 'Normal authenticator clock-skew window failed');
assert.strictEqual(totp.verifyTotp(generated, '000000', { time: now, window: 0 }), code === '000000');

const uri = totp.otpauthUri({ secret: generated, accountName: 'admin@example.test', issuer: 'CAPTaINFiN' });
const parsed = new URL(uri);
assert.strictEqual(parsed.protocol, 'otpauth:');
assert.strictEqual(parsed.hostname, 'totp');
assert.strictEqual(parsed.searchParams.get('secret'), generated);
assert.strictEqual(parsed.searchParams.get('issuer'), 'CAPTaINFiN');
assert.strictEqual(parsed.searchParams.get('algorithm'), 'SHA1');
assert.strictEqual(parsed.searchParams.get('digits'), '6');
assert.strictEqual(parsed.searchParams.get('period'), '30');

console.log('TOTP RFC compatibility and enrollment URI smoke test passed.');
