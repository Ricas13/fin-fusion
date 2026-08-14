'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const {
  createEncryptionContext,
  createDecryptionContext,
  parseHeader
} = require('../src/backup/encrypted-stream');

async function main() {
  const secret = 'test-backup-encryption-key-0123456789abcdef';
  const payload = Buffer.from('CAPTaINFiN encrypted backup smoke payload\n'.repeat(128), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captainfin-backup-smoke-'));
  const file = path.join(dir, 'sample.pgdump.enc');
  try {
    const { header, cipher } = createEncryptionContext(secret);
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    out.write(header);
    await pipeline(Readable.from(payload), cipher, out, { end: false });
    out.write(cipher.getAuthTag());
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });

    const parsed = parseHeader(file);
    if (parsed.metadata.cipher !== 'aes-256-gcm') throw new Error('Unexpected cipher metadata');
    const { decipher, payloadStart, payloadEnd } = createDecryptionContext(file, secret);
    const chunks = [];
    decipher.on('data', chunk => chunks.push(chunk));
    await pipeline(fs.createReadStream(file, { start: payloadStart, end: payloadEnd }), decipher);
    if (!Buffer.concat(chunks).equals(payload)) throw new Error('Backup encryption round trip mismatch');

    const tampered = Buffer.from(fs.readFileSync(file));
    tampered[Math.floor((payloadStart + payloadEnd) / 2)] ^= 0x01;
    fs.writeFileSync(file, tampered, { mode: 0o600 });
    const broken = createDecryptionContext(file, secret);
    let rejected = false;
    try {
      await pipeline(fs.createReadStream(file, { start: broken.payloadStart, end: broken.payloadEnd }), broken.decipher);
    } catch (_) {
      rejected = true;
    }
    if (!rejected) throw new Error('Tampered backup was not rejected');
    console.log('Backup crypto smoke test passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
