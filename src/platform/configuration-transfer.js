'use strict';

const core = require('./configuration-transfer-v2-core');
const { query, transaction } = require('../db');

const DRIFT_KEY = 'jellyfin_drift_policy';

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sourceDocument(input) {
    if (input && typeof input === 'object') return input;
    try { return JSON.parse(String(input || '{}')); }
    catch (_) { return {}; }
}

function normalizeDriftPolicy(value) {
    const source = object(value);
    const clamp = (input, fallback, min, max) => {
        const n = Number.parseInt(input, 10);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    const normalized = {
        healthyMinutes: clamp(source.healthyMinutes, 360, 30, 1440),
        driftMinutes: clamp(source.driftMinutes, 60, 15, 720),
        failureBaseMinutes: clamp(source.failureBaseMinutes, 15, 5, 360),
        failureMaxMinutes: clamp(source.failureMaxMinutes, 360, 15, 1440),
        batchSize: clamp(source.batchSize, 100, 1, 1000)
    };
    if (normalized.failureMaxMinutes < normalized.failureBaseMinutes) {
        normalized.failureMaxMinutes = normalized.failureBaseMinutes;
    }
    return normalized;
}

function parseDocument(input) {
    const parsed = core.parseDocument(input);
    if (parsed.version !== 2) return parsed;
    const source = sourceDocument(input);
    const incoming = source?.configuration?.settings?.[DRIFT_KEY];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        parsed.configuration.settings[DRIFT_KEY] = normalizeDriftPolicy(incoming);
    }
    return parsed;
}

async function exportPortableConfiguration() {
    const document = await core.exportPortableConfiguration();
    if (document.version !== 2) return document;
    const result = await query(`SELECT setting_value FROM platform_settings WHERE setting_key=$1`, [DRIFT_KEY]);
    if (result.rowCount) {
        document.configuration.settings[DRIFT_KEY] = normalizeDriftPolicy(result.rows[0].setting_value);
    }
    return document;
}

async function previewImport(input) {
    const document = parseDocument(input);
    if (document.version !== 2) return core.previewImport(document);
    const result = await core.previewImport(document);
    return {
        ...result,
        document,
        digest: core.digestDocument(document),
        summary: {
            ...result.summary,
            driftPolicy: Object.prototype.hasOwnProperty.call(document.configuration.settings, DRIFT_KEY) ? 1 : 0
        }
    };
}

async function applyImport(input, actorUserId = null) {
    const document = parseDocument(input);
    const result = await core.applyImport(document, actorUserId);
    if (document.version !== 2 || !Object.prototype.hasOwnProperty.call(document.configuration.settings, DRIFT_KEY)) return result;

    const policy = normalizeDriftPolicy(document.configuration.settings[DRIFT_KEY]);
    await transaction(async client => {
        await client.query(`
            INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
            VALUES($1,$2::jsonb,$3,NOW())
            ON CONFLICT(setting_key) DO UPDATE SET
              setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
        `, [DRIFT_KEY, JSON.stringify(policy), actorUserId]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.configuration.import.drift_policy','platform_setting',$2,$3::jsonb)
        `, [actorUserId, DRIFT_KEY, JSON.stringify(policy)]);
    });
    return {
        ...result,
        summary: { ...(result.summary || {}), driftPolicy: 1 }
    };
}

module.exports = {
    ...core,
    parseDocument,
    exportPortableConfiguration,
    previewImport,
    applyImport
};
