'use strict';

const crypto = require('crypto');

function keyFromEnv(name) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) throw new Error(`${name} is required`);

    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== 32) {
        throw new Error(`${name} must be 32 bytes (64 hex chars or base64)`);
    }
    return decoded;
}

function encryptWithEnv(value, envName, prefix) {
    if (value == null || value === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(envName), iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${prefix}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptWithEnv(payload, envName, prefix) {
    if (!payload) return null;
    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== prefix) {
        throw new Error(`Invalid ${prefix} encrypted payload`);
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(envName), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { keyFromEnv, encryptWithEnv, decryptWithEnv };
