'use strict';

const { query } = require('../db');
const requestPolicy = require('./request-plan-policy');

// Per-customer override of the plan default Jellyseerr/Overseerr request
// permission mask (customer_request_permission_overrides.permission_mask).
// The mask is all-or-nothing, like the plan's own request_permissions
// column: NULL means "no override, inherit the plan"; once an admin changes
// any single permission, the whole resulting mask is stored as the
// override (matching the existing managed/unmanaged pattern already used
// by admin-request-users.js's bulk permission grid). This is what
// request-user-sync.js's desiredPermissions() reads to decide what mask
// actually gets pushed to the external Jellyseerr/Overseerr instance.

async function getOverride(customerId) {
    const result = await query(
        'SELECT customer_id,permission_mask,updated_by,updated_at FROM customer_request_permission_overrides WHERE customer_id=$1',
        [customerId]
    );
    return result.rows[0] || null;
}

async function setOverrideMask(customerId, mask, actorUserId = null) {
    const clean = requestPolicy.sanitizePermissionMask(mask) ?? 0;
    await query(`
        INSERT INTO customer_request_permission_overrides(customer_id,permission_mask,updated_by,updated_at)
        VALUES($1,$2,$3,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET permission_mask=EXCLUDED.permission_mask,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, clean, actorUserId]);
}

async function resetOverride(customerId, actorUserId = null) {
    await query(`
        INSERT INTO customer_request_permission_overrides(customer_id,permission_mask,updated_by,updated_at)
        VALUES($1,NULL,$2,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET permission_mask=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, actorUserId]);
}

// planMask: the plan's raw request_permissions value (may be null, meaning
// the plan itself relies on the default mask).
async function effectivePermissions(customerId, planMask) {
    const override = await getOverride(customerId);
    const hasOverride = Boolean(override) && override.permission_mask !== null && override.permission_mask !== undefined;
    const resolvedPlanMask = requestPolicy.sanitizePermissionMask(planMask) ?? requestPolicy.DEFAULT_REQUEST_MASK;
    const effectiveMask = hasOverride ? override.permission_mask : resolvedPlanMask;
    const rows = requestPolicy.CUSTOMER_PERMISSION_DEFS.map(item => ({
        key: item.key,
        label: item.label,
        group: item.group,
        plan: requestPolicy.permissionEnabled(resolvedPlanMask, item.bit),
        override: hasOverride ? requestPolicy.permissionEnabled(override.permission_mask, item.bit) : null,
        effective: requestPolicy.permissionEnabled(effectiveMask, item.bit)
    }));
    return { override, hasOverride, planMask: resolvedPlanMask, effectiveMask, rows };
}

module.exports = { getOverride, setOverrideMask, resetOverride, effectivePermissions };
