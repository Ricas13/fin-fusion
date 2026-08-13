'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(input) {
    const text = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of text) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) continue;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateSecret(bytes = 20) {
    return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret, counter, digits = 6) {
    const key = base32Decode(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function totp(secret, { time = Date.now(), period = 30, digits = 6 } = {}) {
    const counter = Math.floor(time / 1000 / period);
    return hotp(secret, counter, digits);
}

function safeEqualCode(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyTotp(secret, code, { time = Date.now(), period = 30, digits = 6, window = 1 } = {}) {
    const normalized = String(code || '').replace(/\s+/g, '');
    if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
    const current = Math.floor(time / 1000 / period);
    for (let offset = -window; offset <= window; offset += 1) {
        if (safeEqualCode(hotp(secret, current + offset, digits), normalized)) return true;
    }
    return false;
}

function otpauthUri({ secret, accountName, issuer }) {
    const safeIssuer = String(issuer || 'Steam Fusion').slice(0, 80);
    const safeAccount = String(accountName || 'account').slice(0, 120);
    const label = encodeURIComponent(`${safeIssuer}:${safeAccount}`);
    const params = new URLSearchParams({
        secret,
        issuer: safeIssuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30'
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, otpauthUri };
