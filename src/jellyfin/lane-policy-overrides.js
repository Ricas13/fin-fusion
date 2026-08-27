'use strict';

const { query } = require('../db');
const policy = require('./policy');

function lane(value) {
    const normalized = String(value || 'primary').toLowerCase();
    if (!['primary', 'free'].includes(normalized)) throw new Error('Unknown Jellyfin access lane');
    return normalized;
}

async function getPolicyOverride(customerId, accessLane = 'primary') {
    const targetLane = lane(accessLane);
    const result = await query(
        'SELECT * FROM customer_lane_policy_overrides WHERE customer_id=$1 AND access_lane=$2',
        [customerId, targetLane]
    );
    if (result.rowCount) return result.rows[0];
    if (targetLane !== 'primary') return null;
    // Compatibility fallback while older installations are being migrated.
    const legacy = await query('SELECT * FROM customer_policy_overrides WHERE customer_id=$1', [customerId]);
    return legacy.rows[0] || null;
}

function cleanField(field, value) {
    if (!policy.TECHNICAL_FIELDS.includes(field)) throw new Error('Unknown policy field');
    if (field === 'streams') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Streams override must be between 1 and 50');
        return n;
    }
    return Boolean(value);
}

async function setPolicyOverrideField(customerId, accessLane, field, value, actorUserId = null) {
    const targetLane = lane(accessLane);
    const clean = cleanField(field, value);
    await query(`
        INSERT INTO customer_lane_policy_overrides(customer_id,access_lane,${field},updated_by,updated_at)
        VALUES($1,$2,$3,$4,NOW())
        ON CONFLICT (customer_id,access_lane)
        DO UPDATE SET ${field}=EXCLUDED.${field},updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, targetLane, clean, actorUserId]);
}

async function resetPolicyOverrideField(customerId, accessLane, field, actorUserId = null) {
    const targetLane = lane(accessLane);
    if (!policy.TECHNICAL_FIELDS.includes(field)) throw new Error('Unknown policy field');
    await query(`
        INSERT INTO customer_lane_policy_overrides(customer_id,access_lane,updated_by,updated_at)
        VALUES($1,$2,$3,NOW())
        ON CONFLICT (customer_id,access_lane)
        DO UPDATE SET ${field}=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, targetLane, actorUserId]);
}

async function resetAllPolicyOverrides(customerId, accessLane, actorUserId = null) {
    const targetLane = lane(accessLane);
    const sets = policy.TECHNICAL_FIELDS.map(field => `${field}=NULL`).join(',');
    await query(`
        INSERT INTO customer_lane_policy_overrides(customer_id,access_lane,updated_by,updated_at)
        VALUES($1,$2,$3,NOW())
        ON CONFLICT (customer_id,access_lane)
        DO UPDATE SET ${sets},updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, targetLane, actorUserId]);
}

async function effectiveTechnical(customerId, accessLane, plan) {
    const override = await getPolicyOverride(customerId, accessLane);
    const technicalRows = policy.effectiveTechnicalPolicy(plan, override);
    return { override, technicalRows, technical: policy.flattenEffective(technicalRows) };
}

module.exports = {
    lane,
    getPolicyOverride,
    setPolicyOverrideField,
    resetPolicyOverrideField,
    resetAllPolicyOverrides,
    effectiveTechnical
};
