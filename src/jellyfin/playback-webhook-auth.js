'use strict';

const crypto = require('crypto');

const TOKEN_CONTEXT = 'captainfin:jellyfin-playback-webhook:v1:';

function cleanServerId(serverId) {
    return String(serverId || '').trim().toLowerCase();
}

function deriveServerSecret(masterSecret, serverId) {
    const master = String(masterSecret || '');
    const id = cleanServerId(serverId);
    if (!master) throw new Error('JELLYFIN_WEBHOOK_SECRET is required');
    if (!id) throw new Error('Jellyfin server id is required');
    return crypto.createHmac('sha256', master).update(`${TOKEN_CONTEXT}${id}`, 'utf8').digest('hex');
}

function sameSecret(actual, expected) {
    const a = Buffer.from(String(actual || ''), 'utf8');
    const b = Buffer.from(String(expected || ''), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function verifyServerSecret(provided, masterSecret, serverId, { allowLegacy = false } = {}) {
    const master = String(masterSecret || '');
    if (!master) return { authenticated: false, mode: 'disabled' };
    const expected = deriveServerSecret(master, serverId);
    if (sameSecret(provided, expected)) return { authenticated: true, mode: 'server' };
    if (allowLegacy && sameSecret(provided, master)) return { authenticated: true, mode: 'legacy' };
    return { authenticated: false, mode: 'invalid' };
}

module.exports = {
    deriveServerSecret,
    verifyServerSecret,
    sameSecret,
};
