'use strict';

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bitString = '';
    for (const byte of buffer) bitString += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let i = 0; i < bitString.length; i += 5) {
        const chunk = bitString.slice(i, i + 5).padEnd(5, '0');
        output += ALPHABET[Number.parseInt(chunk, 2)];
    }
    return output;
}

function base32Decode(input) {
    const text = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bitString = '';
    for (const char of text) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) continue;
        bitString += index.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bitString.length; i += 8) {
        bytes.push(Number.parseInt(bitString.slice(i, i + 8), 2));
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
        if (current + offset < 0) continue;
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
