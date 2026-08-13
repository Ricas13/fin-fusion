const crypto = require('crypto');

function getKey() {
    const raw = process.env.DATA_ENCRYPTION_KEY || '';
    if (!raw) throw new Error('DATA_ENCRYPTION_KEY is required');

    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== 32) {
        throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
    }
    return decoded;
}

function encryptString(value) {
    if (value == null || value === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptString(payload) {
    if (!payload) return null;
    const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encryptString, decryptString };
