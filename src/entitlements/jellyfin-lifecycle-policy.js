'use strict';

const { query, transaction } = require('../db');

const KEY = 'jellyfin_lifecycle_policy_v2';
const DEFAULTS = Object.freeze({ enabled: true, dryRun: false });
const SAFE_UNCONFIGURED = Object.freeze({ enabled: false, dryRun: true });

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || ['true','1','on','yes'].includes(String(value).toLowerCase());
}

function normalize(value = {}) {
    return {
        enabled: bool(value.enabled, DEFAULTS.enabled),
        dryRun: bool(value.dryRun, DEFAULTS.dryRun)
    };
}

function explicitlyConfigured(value) {
    return Boolean(
        value
        && Object.prototype.hasOwnProperty.call(value, 'enabled')
        && Object.prototype.hasOwnProperty.call(value, 'dryRun')
    );
}

async function get() {
    const result = await query(
        'SELECT setting_value FROM platform_settings WHERE setting_key=$1',
        [KEY]
    );
    const stored = result.rows[0]?.setting_value || null;

    // Destructive automation never enables itself from defaults. An operator
    // must have explicitly saved both execution switches.
    if (!result.rowCount || !explicitlyConfigured(stored)) {
        return {
            ...DEFAULTS,
            ...SAFE_UNCONFIGURED,
            configurationMissing: true
        };
    }

    return {
        ...normalize(stored),
        configurationMissing: false
    };
}

async function save(input, actorUserId = null) {
    const value = normalize(input);
    await transaction(async client => {
        await client.query(`
            INSERT INTO platform_settings(setting_key,setting_value,updated_by)
            VALUES($1,$2::jsonb,$3)
            ON CONFLICT(setting_key) DO UPDATE SET
                setting_value=EXCLUDED.setting_value,
                updated_by=EXCLUDED.updated_by,
                updated_at=NOW()
        `, [KEY, JSON.stringify(value), actorUserId]);

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.jellyfin.lifecycle_policy.update','platform_setting',NULL,$2::jsonb)
        `, [
            actorUserId,
            JSON.stringify({
                ...value,
                settingKey: KEY,
                portalAccountPreserved: true,
                thresholdOwner: 'free_server'
            })
        ]);
    });
    return value;
}

function categoryFor({ serverClass = null, billingInterval = null, priceMinor = 0 } = {}) {
    if (String(serverClass || '').toLowerCase() === 'free') return 'free';
    if (String(billingInterval || '').toLowerCase() === 'trial') return 'trial';
    return Number(priceMinor || 0) > 0 ? 'paid' : 'free';
}

module.exports = {
    KEY,
    DEFAULTS,
    SAFE_UNCONFIGURED,
    normalize,
    explicitlyConfigured,
    get,
    save,
    categoryFor
};
