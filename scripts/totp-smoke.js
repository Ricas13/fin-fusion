'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const uri = totp.otpauthUri({ secret: generated, accountName: 'admin@example.test', issuer: 'CAPTAiNFiN' });
const parsed = new URL(uri);
assert.strictEqual(parsed.protocol, 'otpauth:');
assert.strictEqual(parsed.hostname, 'totp');
assert.strictEqual(parsed.searchParams.get('secret'), generated);
assert.strictEqual(parsed.searchParams.get('issuer'), 'CAPTAiNFiN');
assert.strictEqual(parsed.searchParams.get('algorithm'), 'SHA1');
assert.strictEqual(parsed.searchParams.get('digits'), '6');
assert.strictEqual(parsed.searchParams.get('period'), '30');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/auth/staff-controller.js'), 'utf8');
const setupView = fs.readFileSync(path.join(root, 'views/auth/2fa-setup.ejs'), 'utf8');
assert(dockerfile.includes('qrencode'), 'Production image must include the local QR encoder');
assert(controller.includes("spawnSync('qrencode'"), '2FA setup must generate QR locally');
assert(controller.includes('input:String(uri||\'\')'), 'TOTP secret URI must be passed over stdin, not exposed in a command argument');
assert(controller.includes('data:image/svg+xml;base64,'), 'QR must be embedded locally without a third-party QR service');
assert(setupView.includes('qrDataUri'), '2FA setup view must render the QR code');
assert(setupView.includes("Can't scan it? Use the manual setup key"), 'Manual authenticator enrollment fallback must remain available');
assert(!setupView.includes('<%= uri %>'), 'Raw otpauth URI should not clutter the enrollment screen');

console.log('TOTP RFC compatibility, QR enrollment, and manual fallback smoke test passed.');
