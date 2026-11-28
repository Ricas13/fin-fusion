'use strict';

// A lock timeout means the guarded work never ran. It says nothing about the
// customer's access, so no caller may treat it as proof that provisioning failed
// and delete, cancel or revoke anything. Match stable codes only, never messages.
const LOCK_TIMEOUT_CODES = Object.freeze([
    'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT',
    'STREMIO_OPERATION_LOCK_TIMEOUT'
]);
const MAX_ERROR_NODES = 50;

// Wrapped errors keep the original under .cause (single) or .errors (aggregate).
// The visited set and node cap keep cyclic or very large chains bounded.
function isLockTimeoutError(error) {
    const seen = new Set();
    const queue = [error];
    while (queue.length && seen.size < MAX_ERROR_NODES) {
        const node = queue.shift();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (LOCK_TIMEOUT_CODES.includes(node.code)) return true;
        if (node.cause) queue.push(node.cause);
        if (Array.isArray(node.errors)) queue.push(...node.errors.slice(0, MAX_ERROR_NODES));
    }
    return false;
}

module.exports = { LOCK_TIMEOUT_CODES, isLockTimeoutError };
