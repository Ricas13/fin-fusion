'use strict';

const { query } = require('../db');
const registry = require('./registry');

function safe(value, max = 1000) {
    return String(value == null ? '' : value).replace(/[\r\n\t\u2028\u2029]+/g, ' ').slice(0, max);
}

function alreadyAbsent(error) {
    return /\b404\b|not found/i.test(String(error?.message || error || ''));
}

async function recordFailure({ customerId, serverId, userId, stage, cleanupError, originalError }) {
    await query(`
        INSERT INTO audit_log(action,entity_type,entity_id,metadata)
        VALUES('jellyfin.provisioning.compensation_failed','customer',$1,$2::jsonb)
    `, [customerId, JSON.stringify({
        serverId,
        jellyfinUserId: userId,
        stage,
        cleanupError: safe(cleanupError?.message || cleanupError),
        originalError: safe(originalError?.message || originalError)
    })]).catch(() => {});
}

async function removeCreatedUser({ customerId, serverId, userId, stage, originalError }) {
    if (!serverId || !userId) throw new Error('Provisioning compensation requires a Jellyfin server and user id.');
    try {
        await registry.request(serverId, `/Users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        return { deleted: true, alreadyAbsent: false };
    } catch (cleanupError) {
        if (alreadyAbsent(cleanupError)) return { deleted: true, alreadyAbsent: true };
        console.error('Jellyfin provisioning compensation failed.', {
            customerId: safe(customerId, 100),
            serverId: safe(serverId, 100),
            jellyfinUserId: safe(userId, 160),
            stage: safe(stage, 80),
            error: safe(cleanupError?.message || cleanupError)
        });
        await recordFailure({ customerId, serverId, userId, stage, cleanupError, originalError });
        const error = new Error('Jellyfin account creation could not be completed and automatic rollback failed. Operator attention is required.');
        error.code = 'JELLYFIN_PROVISIONING_COMPENSATION_FAILED';
        error.cause = originalError;
        error.cleanupError = cleanupError;
        error.serverId = serverId;
        error.jellyfinUserId = userId;
        throw error;
    }
}

function rolledBackError(message, code, cause) {
    const error = new Error(message);
    error.code = code;
    error.cause = cause;
    return error;
}

module.exports = { safe, alreadyAbsent, recordFailure, removeCreatedUser, rolledBackError };
