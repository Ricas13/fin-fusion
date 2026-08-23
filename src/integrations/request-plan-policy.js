'use strict';

// Keep these values aligned with Seerr/Jellyseerr's public Permission enum.
// Deliberately excluded from plan control: ADMIN, MANAGE_SETTINGS, MANAGE_USERS,
// MANAGE_REQUESTS, MANAGE_ISSUES and MANAGE_BLOCKLIST. A customer product must
// never be able to grant operator/admin capabilities in the request service.
const CUSTOMER_PERMISSION_DEFS = Object.freeze([
  { bit: 32, key: 'request', label: 'Request media', group: 'Requests', help: 'Base permission to create requests.' },
  { bit: 262144, key: 'request_movie', label: 'Request movies', group: 'Requests' },
  { bit: 524288, key: 'request_tv', label: 'Request TV', group: 'Requests' },
  { bit: 1024, key: 'request_4k', label: 'Request 4K', group: 'Requests' },
  { bit: 2048, key: 'request_4k_movie', label: 'Request 4K movies', group: 'Requests' },
  { bit: 4096, key: 'request_4k_tv', label: 'Request 4K TV', group: 'Requests' },
  { bit: 8192, key: 'request_advanced', label: 'Advanced requests', group: 'Requests' },
  { bit: 16384, key: 'request_view', label: 'View requests', group: 'Requests' },
  { bit: 64, key: 'vote', label: 'Vote on requests', group: 'Requests' },

  { bit: 128, key: 'auto_approve', label: 'Auto-approve requests', group: 'Approval' },
  { bit: 256, key: 'auto_approve_movie', label: 'Auto-approve movies', group: 'Approval' },
  { bit: 512, key: 'auto_approve_tv', label: 'Auto-approve TV', group: 'Approval' },
  { bit: 32768, key: 'auto_approve_4k', label: 'Auto-approve 4K', group: 'Approval' },
  { bit: 65536, key: 'auto_approve_4k_movie', label: 'Auto-approve 4K movies', group: 'Approval' },
  { bit: 131072, key: 'auto_approve_4k_tv', label: 'Auto-approve 4K TV', group: 'Approval' },

  { bit: 8388608, key: 'auto_request', label: 'Automatic requests', group: 'Automation' },
  { bit: 16777216, key: 'auto_request_movie', label: 'Automatic movie requests', group: 'Automation' },
  { bit: 33554432, key: 'auto_request_tv', label: 'Automatic TV requests', group: 'Automation' },
  { bit: 67108864, key: 'recent_view', label: 'Recently added', group: 'Discovery' },
  { bit: 134217728, key: 'watchlist_view', label: 'Watchlist', group: 'Discovery' },
  { bit: 2097152, key: 'view_issues', label: 'View issues', group: 'Issues' },
  { bit: 4194304, key: 'create_issues', label: 'Create issues', group: 'Issues' },
  { bit: 1073741824, key: 'view_blocklist', label: 'View blocklist', group: 'Discovery' }
]);

const SAFE_MASK = CUSTOMER_PERMISSION_DEFS.reduce((mask, item) => mask | BigInt(item.bit), 0n);
const DEFAULT_REQUEST_MASK = 32;

function maskBigInt(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const n = BigInt(String(value));
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}
function sanitizePermissionMask(value) {
  const raw = maskBigInt(value);
  if (raw === null) return null;
  return Number(raw & SAFE_MASK);
}
function permissionEnabled(mask, bit) {
  const raw = maskBigInt(mask);
  if (raw === null) return false;
  return (raw & BigInt(bit)) === BigInt(bit);
}
function permissionMaskFromBody(body) {
  if (String(body?.permissionMode || '') !== 'managed') return null;
  let mask = 0n;
  for (const item of CUSTOMER_PERMISSION_DEFS) {
    if (body?.[`permission_${item.bit}`] === 'on' || body?.[`permission_${item.bit}`] === '1') mask |= BigInt(item.bit);
  }
  return Number(mask & SAFE_MASK);
}
function optionalText(value, max = 32) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}
function triState(value) {
  if (String(value) === 'enabled') return true;
  if (String(value) === 'disabled') return false;
  return null;
}
function planPermissionMask(plan, fallback) {
  const configured = sanitizePermissionMask(plan?.request_permissions);
  return configured === null ? sanitizePermissionMask(fallback) : configured;
}

module.exports = {
  CUSTOMER_PERMISSION_DEFS,
  SAFE_MASK,
  DEFAULT_REQUEST_MASK,
  sanitizePermissionMask,
  permissionEnabled,
  permissionMaskFromBody,
  optionalText,
  triState,
  planPermissionMask
};
