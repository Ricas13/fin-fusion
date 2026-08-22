'use strict';

const crypto = require('crypto');
const { safeFetch } = require('./outbound-url-policy');

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_PREFIXES = 512;
const cache = new Map();

function mode(env = process.env) {
    const configured = String(env.PASSWORD_BREACH_CHECK_MODE || '').trim().toLowerCase();
    if (['required','best_effort','off'].includes(configured)) return configured;
    return String(env.NODE_ENV || '').toLowerCase() === 'test' ? 'off' : 'required';
}

function hashParts(password) {
    const digest = crypto.createHash('sha1').update(String(password || ''), 'utf8').digest('hex').toUpperCase();
    return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

function parseRangeBody(body) {
    const entries = new Map();
    for (const line of String(body || '').split(/\r?\n/)) {
        const match = line.trim().match(/^([0-9A-F]{35}):(\d+)$/i);
        if (!match) continue;
        entries.set(match[1].toUpperCase(), Number(match[2]) || 0);
    }
    return entries;
}

function putCache(prefix, entries, now = Date.now()) {
    if (cache.size >= CACHE_MAX_PREFIXES && !cache.has(prefix)) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
    }
    cache.delete(prefix);
    cache.set(prefix, { entries, expiresAt: now + CACHE_TTL_MS });
}

async function range(prefix, { fetcher = safeFetch, now = Date.now() } = {}) {
    const prior = cache.get(prefix);
    if (prior && prior.expiresAt > now) {
        // Refresh insertion order to keep frequently used prefixes in the bounded cache.
        cache.delete(prefix);
        cache.set(prefix, prior);
        return prior.entries;
    }
    if (prior) cache.delete(prefix);

    const response = await fetcher(`${RANGE_URL}${prefix}`, {
        purpose: 'breached-password k-anonymity check',
        headers: {
            'Add-Padding': 'true',
            'User-Agent': 'CAPTA.iNFiN-password-safety'
        },
        timeoutMs: Math.max(1500, Math.min(10000, Number(process.env.PASSWORD_BREACH_CHECK_TIMEOUT_MS || 5000))),
        maxBytes: 1024 * 1024
    });
    if (!response.ok) throw new Error(`Password breach service returned HTTP ${response.status}.`);
    const body = await response.text();
    const entries = parseRangeBody(body);
    putCache(prefix, entries, now);
    return entries;
}

async function check(password, options = {}) {
    const selectedMode = options.mode || mode(options.env || process.env);
    if (selectedMode === 'off') return { checked: false, pwned: false, count: 0, mode: selectedMode };
    const { prefix, suffix } = hashParts(password);
    try {
        const entries = await range(prefix, options);
        const count = Number(entries.get(suffix) || 0);
        return { checked: true, pwned: count > 0, count, mode: selectedMode };
    } catch (error) {
        if (selectedMode === 'best_effort') {
            console.warn('Breached-password check unavailable:', error.message);
            return { checked: false, pwned: false, count: 0, mode: selectedMode, error: error.message };
        }
        const unavailable = new Error('Password safety checking is temporarily unavailable. Try again shortly.');
        unavailable.code = 'PASSWORD_BREACH_CHECK_UNAVAILABLE';
        unavailable.cause = error;
        throw unavailable;
    }
}

async function assertNotBreached(password, options = {}) {
    const result = await check(password, options);
    if (result.pwned) {
        const error = new Error('Choose a different password. This password appears in known breach data and is not safe to use.');
        error.code = 'PASSWORD_BREACHED';
        throw error;
    }
    return result;
}

function clearCache() {
    cache.clear();
}

module.exports = {
    RANGE_URL,
    CACHE_TTL_MS,
    CACHE_MAX_PREFIXES,
    mode,
    hashParts,
    parseRangeBody,
    check,
    assertNotBreached,
    clearCache
};
