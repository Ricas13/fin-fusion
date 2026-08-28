'use strict';

const { query } = require('../db');

const SETTINGS_KEY = 'notification_expiry_policy_v1';
const SUPPORTED_MILESTONES = [7, 3, 1];
const LEGACY_WARNING_DAYS = Math.max(1, Math.min(30, Number(process.env.SUBSCRIPTION_EXPIRY_WARNING_DAYS || 7) || 7));
const DEFAULT_POLICY = Object.freeze({ milestones: Object.freeze([LEGACY_WARNING_DAYS]) });

function inputMilestones(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.milestones)) return value.milestones;
    if (value == null || value === '') return [];
    return [value];
}

function normalizeMilestones(value, { fallback = DEFAULT_POLICY.milestones } = {}) {
    const normalized = [...new Set(inputMilestones(value)
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isInteger(item) && item >= 1 && item <= 30))]
        .sort((a, b) => b - a);
    if (normalized.length) return normalized;
    return [...fallback];
}

function normalizePolicy(value, { fallback = DEFAULT_POLICY } = {}) {
    return { milestones: normalizeMilestones(value?.milestones ?? value, { fallback: fallback.milestones }) };
}

async function load() {
    const result = await query(`SELECT setting_value FROM platform_settings WHERE setting_key=$1`, [SETTINGS_KEY]);
    if (!result.rowCount) return { ...normalizePolicy(DEFAULT_POLICY), stored: false };
    return { ...normalizePolicy(result.rows[0].setting_value), stored: true };
}

async function save(input, actorUserId = null) {
    const supplied = inputMilestones(input?.milestones ?? input);
    const milestones = normalizeMilestones(supplied, { fallback: [] });
    if (!milestones.length) throw new Error('Choose at least one expiry reminder milestone.');
    const value = { milestones };
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [SETTINGS_KEY, JSON.stringify(value), actorUserId]);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.notifications.expiry_policy.update','platform_setting',$2,$3::jsonb)`, [actorUserId, SETTINGS_KEY, JSON.stringify(value)]);
    return { ...value, stored: true };
}

module.exports = {
    SETTINGS_KEY,
    SUPPORTED_MILESTONES,
    LEGACY_WARNING_DAYS,
    DEFAULT_POLICY,
    normalizeMilestones,
    normalizePolicy,
    load,
    save
};
