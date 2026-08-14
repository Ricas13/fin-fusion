'use strict';

const { query, transaction } = require('../db');

let cachedRequired = null;
let loadingPromise = null;

function envDefault() {
    return process.env.REQUIRE_ADMIN_2FA === 'true';
}

async function reload() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='security_policy'");
    const stored = result.rows[0]?.setting_value;
    cachedRequired = typeof stored?.requireAdminTwoFactor === 'boolean'
        ? stored.requireAdminTwoFactor
        : envDefault();
    return cachedRequired;
}

async function required() {
    if (typeof cachedRequired === 'boolean') return cachedRequired;
    if (!loadingPromise) loadingPromise = reload().finally(() => { loadingPromise = null; });
    return loadingPromise;
}

function requiredSync() {
    return typeof cachedRequired === 'boolean' ? cachedRequired : envDefault();
}

async function setRequired(enabled, actorUserId) {
    const next = Boolean(enabled);
    const previous = await required();
    await transaction(async client => {
        await client.query(`
            INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
            VALUES('security_policy',$1::jsonb,$2,NOW())
            ON CONFLICT(setting_key) DO UPDATE
            SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
        `, [JSON.stringify({ requireAdminTwoFactor: next }), actorUserId]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.security.2fa_policy','platform_setting','security_policy',$2::jsonb)
        `, [actorUserId, JSON.stringify({ previous, required: next })]);
    });
    cachedRequired = next;
    return next;
}

module.exports = { required, requiredSync, reload, setRequired };
