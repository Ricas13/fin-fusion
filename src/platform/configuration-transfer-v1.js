'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');

const FORMAT = 'steam-fusion-portable-configuration';
const VERSION = 1;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const SETTING_KEYS = new Set([
    'platform',
    'storefront',
    'storefront_features',
    'admin_defaults',
    'referral_program'
]);

const ENUMS = {
    audience: new Set(['direct']),
    billing_interval: new Set(['trial', 'month', '6_months', 'year', 'custom']),
    server_class: new Set(['premium', 'free', 'custom']),
    library_access_mode: new Set(['all', 'exclude', 'include']),
    placement_strategy: new Set(['balanced', 'lowest_customers', 'lowest_streams', 'weighted', 'manual'])
};

class ConfigurationValidationError extends Error {
    constructor(message, path = '') {
        super(message);
        this.name = 'ConfigurationValidationError';
        this.path = path;
    }
}

function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value, path, { required = false, max = 500, pattern = null } = {}) {
    if (value == null || value === '') {
        if (required) throw new ConfigurationValidationError('Value is required.', path);
        return '';
    }
    if (typeof value !== 'string') throw new ConfigurationValidationError('Expected text.', path);
    const clean = value.trim();
    if (required && !clean) throw new ConfigurationValidationError('Value is required.', path);
    if (clean.length > max) throw new ConfigurationValidationError(`Must be at most ${max} characters.`, path);
    if (pattern && !pattern.test(clean)) throw new ConfigurationValidationError('Value has an invalid format.', path);
    return clean;
}

function bool(value, path) {
    if (typeof value !== 'boolean') throw new ConfigurationValidationError('Expected true or false.', path);
    return value;
}

function integer(value, path, min, max, { nullable = false } = {}) {
    if ((value == null || value === '') && nullable) return null;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ConfigurationValidationError(`Expected an integer between ${min} and ${max}.`, path);
    }
    return value;
}

function enumValue(value, path, allowed) {
    if (typeof value !== 'string' || !allowed.has(value)) {
        throw new ConfigurationValidationError(`Unsupported value: ${String(value)}`, path);
    }
    return value;
}

function stringArray(value, path, { maxItems = 500, maxLength = 200 } = {}) {
    if (!Array.isArray(value)) throw new ConfigurationValidationError('Expected a list.', path);
    if (value.length > maxItems) throw new ConfigurationValidationError(`Too many items; maximum is ${maxItems}.`, path);
    const seen = new Set();
    const output = [];
    for (let i = 0; i < value.length; i++) {
        const item = text(value[i], `${path}[${i}]`, { required: true, max: maxLength });
        const key = item.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            output.push(item);
        }
    }
    return output;
}

function keepKeys(source, allowed) {
    const output = {};
    if (!plainObject(source)) return output;
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key];
    return output;
}

function normalizeSetting(key, value) {
    if (key === 'platform') {
        const src = keepKeys(value, [
            'siteName', 'storefrontEnabled', 'publicRegistration', 'requireEmailVerification',
            'entitlementJobIntervalMs', 'serverHealthIntervalMs', 'overseerrUrl'
        ]);
        const out = {};
        if ('siteName' in src) out.siteName = text(src.siteName, 'settings.platform.siteName', { required: true, max: 80 });
        if ('storefrontEnabled' in src) out.storefrontEnabled = bool(src.storefrontEnabled, 'settings.platform.storefrontEnabled');
        if ('publicRegistration' in src) out.publicRegistration = bool(src.publicRegistration, 'settings.platform.publicRegistration');
        if ('requireEmailVerification' in src) out.requireEmailVerification = bool(src.requireEmailVerification, 'settings.platform.requireEmailVerification');
        if ('entitlementJobIntervalMs' in src) out.entitlementJobIntervalMs = integer(src.entitlementJobIntervalMs, 'settings.platform.entitlementJobIntervalMs', 30000, 10800000);
        if ('serverHealthIntervalMs' in src) out.serverHealthIntervalMs = integer(src.serverHealthIntervalMs, 'settings.platform.serverHealthIntervalMs', 30000, 10800000);
        if ('overseerrUrl' in src) {
            const url = text(src.overseerrUrl, 'settings.platform.overseerrUrl', { max: 500 });
            if (url) {
                let parsed;
                try { parsed = new URL(url); } catch (_) { throw new ConfigurationValidationError('Expected a valid http/https URL.', 'settings.platform.overseerrUrl'); }
                if (!['http:', 'https:'].includes(parsed.protocol)) throw new ConfigurationValidationError('Expected an http/https URL.', 'settings.platform.overseerrUrl');
                out.overseerrUrl = parsed.href;
            } else out.overseerrUrl = '';
        }
        return out;
    }
    if (key === 'storefront') {
        const src = keepKeys(value, ['heroTitle', 'heroSubtitle', 'featureTitle', 'supportEmail', 'announcement']);
        const out = {};
        if ('heroTitle' in src) out.heroTitle = text(src.heroTitle, 'settings.storefront.heroTitle', { max: 140 });
        if ('heroSubtitle' in src) out.heroSubtitle = text(src.heroSubtitle, 'settings.storefront.heroSubtitle', { max: 500 });
        if ('featureTitle' in src) out.featureTitle = text(src.featureTitle, 'settings.storefront.featureTitle', { max: 140 });
        if ('supportEmail' in src) out.supportEmail = text(src.supportEmail, 'settings.storefront.supportEmail', { max: 254 });
        if ('announcement' in src) out.announcement = text(src.announcement, 'settings.storefront.announcement', { max: 200 });
        return out;
    }
    if (key === 'storefront_features') return stringArray(value, 'settings.storefront_features', { maxItems: 50, maxLength: 200 });
    if (key === 'admin_defaults') {
        const src = keepKeys(value, ['defaultPlanCode', 'defaultServerClass', 'defaultServerPriority', 'defaultServerMaxUsers', 'expiringWindowDays', 'recentCustomerLimit']);
        const out = {};
        if ('defaultPlanCode' in src) out.defaultPlanCode = text(src.defaultPlanCode, 'settings.admin_defaults.defaultPlanCode', { max: 80 });
        if ('defaultServerClass' in src) out.defaultServerClass = enumValue(src.defaultServerClass, 'settings.admin_defaults.defaultServerClass', ENUMS.server_class);
        if ('defaultServerPriority' in src) out.defaultServerPriority = integer(src.defaultServerPriority, 'settings.admin_defaults.defaultServerPriority', 0, 10000);
        if ('defaultServerMaxUsers' in src) out.defaultServerMaxUsers = integer(src.defaultServerMaxUsers, 'settings.admin_defaults.defaultServerMaxUsers', 0, 100000);
        if ('expiringWindowDays' in src) out.expiringWindowDays = integer(src.expiringWindowDays, 'settings.admin_defaults.expiringWindowDays', 1, 30);
        if ('recentCustomerLimit' in src) out.recentCustomerLimit = integer(src.recentCustomerLimit, 'settings.admin_defaults.recentCustomerLimit', 5, 50);
        return out;
    }
    if (key === 'referral_program') {
        const src = keepKeys(value, ['enabled', 'rewardDays']);
        const out = {};
        if ('enabled' in src) out.enabled = bool(src.enabled, 'settings.referral_program.enabled');
        if ('rewardDays' in src) out.rewardDays = integer(src.rewardDays, 'settings.referral_program.rewardDays', 1, 365);
        return out;
    }
    throw new ConfigurationValidationError(`Unsupported setting ${key}.`, `settings.${key}`);
}

function normalizePool(value, path) {
    if (!Array.isArray(value)) throw new ConfigurationValidationError('Expected a server pool list.', path);
    if (value.length > 100) throw new ConfigurationValidationError('Server pool is too large.', path);
    const seen = new Set();
    return value.map((entry, index) => {
        if (!plainObject(entry)) throw new ConfigurationValidationError('Expected a server pool object.', `${path}[${index}]`);
        const serverSlug = text(entry.serverSlug, `${path}[${index}].serverSlug`, { required: true, max: 80, pattern: /^[A-Za-z0-9._-]+$/ });
        const key = serverSlug.toLowerCase();
        if (seen.has(key)) throw new ConfigurationValidationError(`Duplicate server slug ${serverSlug}.`, `${path}[${index}].serverSlug`);
        seen.add(key);
        return { serverSlug, weight: integer(entry.weight == null ? 100 : entry.weight, `${path}[${index}].weight`, 1, 10000) };
    });
}

function normalizePlan(source, index) {
    const path = `plans[${index}]`;
    if (!plainObject(source)) throw new ConfigurationValidationError('Expected a plan object.', path);
    return {
        code: text(source.code, `${path}.code`, { required: true, max: 80, pattern: /^[A-Za-z0-9._-]+$/ }),
        name: text(source.name, `${path}.name`, { required: true, max: 160 }),
        description: text(source.description || '', `${path}.description`, { max: 1000 }),
        audience: enumValue(source.audience, `${path}.audience`, ENUMS.audience),
        billing_interval: enumValue(source.billing_interval, `${path}.billing_interval`, ENUMS.billing_interval),
        duration_days: integer(source.duration_days, `${path}.duration_days`, 1, 3650, { nullable: true }),
        price_minor: integer(source.price_minor, `${path}.price_minor`, 0, 100000000),
        currency: text(source.currency, `${path}.currency`, { required: true, max: 3, pattern: /^[A-Za-z]{3}$/ }).toUpperCase(),
        streams: integer(source.streams, `${path}.streams`, 1, 50),
        allow_downloads: bool(source.allow_downloads, `${path}.allow_downloads`),
        allow_video_transcoding: bool(source.allow_video_transcoding, `${path}.allow_video_transcoding`),
        allow_audio_transcoding: bool(source.allow_audio_transcoding, `${path}.allow_audio_transcoding`),
        allow_live_tv: bool(source.allow_live_tv, `${path}.allow_live_tv`),
        allow_live_tv_management: bool(source.allow_live_tv_management, `${path}.allow_live_tv_management`),
        allow_4k: bool(source.allow_4k, `${path}.allow_4k`),
        allow_remuxing: bool(source.allow_remuxing, `${path}.allow_remuxing`),
        allow_remote_access: bool(source.allow_remote_access, `${path}.allow_remote_access`),
        server_class: enumValue(source.server_class, `${path}.server_class`, ENUMS.server_class),
        active: bool(source.active, `${path}.active`),
        visible: bool(source.visible, `${path}.visible`),
        sort_order: integer(source.sort_order, `${path}.sort_order`, -100000, 100000),
        library_access_mode: enumValue(source.library_access_mode, `${path}.library_access_mode`, ENUMS.library_access_mode),
        library_names: stringArray(source.library_names || [], `${path}.library_names`),
        placement_strategy: enumValue(source.placement_strategy, `${path}.placement_strategy`, ENUMS.placement_strategy),
        serverPool: normalizePool(source.serverPool || [], `${path}.serverPool`)
    };
}

function normalizeNotification(source, index) {
    const path = `notifications[${index}]`;
    if (!plainObject(source)) throw new ConfigurationValidationError('Expected a notification object.', path);
    return {
        event_type: text(source.event_type, `${path}.event_type`, { required: true, max: 120, pattern: /^[A-Za-z0-9._-]+$/ }),
        telegram_enabled: bool(source.telegram_enabled, `${path}.telegram_enabled`),
        email_enabled: bool(source.email_enabled, `${path}.email_enabled`)
    };
}

function parseDocument(input) {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    if (Buffer.byteLength(raw || '', 'utf8') > MAX_DOCUMENT_BYTES) throw new ConfigurationValidationError('Configuration document exceeds 512 KiB.');
    let parsed;
    try { parsed = typeof input === 'string' ? JSON.parse(input) : input; }
    catch (_) { throw new ConfigurationValidationError('Configuration is not valid JSON.'); }
    if (!plainObject(parsed)) throw new ConfigurationValidationError('Configuration document must be a JSON object.');
    if (parsed.format !== FORMAT) throw new ConfigurationValidationError(`Unsupported configuration format. Expected ${FORMAT}.`, 'format');
    if (parsed.version !== VERSION) throw new ConfigurationValidationError(`Unsupported configuration version ${String(parsed.version)}.`, 'version');
    if (!plainObject(parsed.configuration)) throw new ConfigurationValidationError('Missing configuration object.', 'configuration');

    const settings = {};
    const inputSettings = parsed.configuration.settings || {};
    if (!plainObject(inputSettings)) throw new ConfigurationValidationError('Settings must be an object.', 'settings');
    for (const [key, value] of Object.entries(inputSettings)) {
        if (!SETTING_KEYS.has(key)) throw new ConfigurationValidationError(`Unsupported setting ${key}.`, `settings.${key}`);
        settings[key] = normalizeSetting(key, value);
    }

    const inputPlans = parsed.configuration.plans || [];
    if (!Array.isArray(inputPlans) || inputPlans.length > 500) throw new ConfigurationValidationError('Plans must be a list of at most 500 items.', 'plans');
    const plans = inputPlans.map(normalizePlan);
    const planCodes = new Set();
    for (const plan of plans) {
        const key = plan.code.toLowerCase();
        if (planCodes.has(key)) throw new ConfigurationValidationError(`Duplicate plan code ${plan.code}.`, 'plans');
        planCodes.add(key);
    }

    const inputNotifications = parsed.configuration.notifications || [];
    if (!Array.isArray(inputNotifications) || inputNotifications.length > 500) throw new ConfigurationValidationError('Notifications must be a list of at most 500 items.', 'notifications');
    const notifications = inputNotifications.map(normalizeNotification);
    const events = new Set();
    for (const item of notifications) {
        const key = item.event_type.toLowerCase();
        if (events.has(key)) throw new ConfigurationValidationError(`Duplicate notification event ${item.event_type}.`, 'notifications');
        events.add(key);
    }

    return {
        format: FORMAT,
        version: VERSION,
        configuration: { settings, plans, notifications },
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded.slice(0, 50).map(v => String(v).slice(0, 200)) : []
    };
}

function digestDocument(document) {
    return crypto.createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex');
}

async function exportPortableConfiguration() {
    const [settingsResult, plansResult, notificationsResult] = await Promise.all([
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key = ANY($1::text[]) ORDER BY setting_key`, [Array.from(SETTING_KEYS)]),
        query(`
            SELECT p.code,p.name,p.description,p.audience,p.billing_interval,p.duration_days,p.price_minor,p.currency,
                   p.streams,p.allow_downloads,p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,
                   p.allow_live_tv_management,p.allow_4k,p.allow_remuxing,p.allow_remote_access,p.server_class,p.active,
                   p.visible,p.sort_order,p.library_access_mode,
                   p.library_names,p.placement_strategy,
                   COALESCE((
                       SELECT jsonb_agg(jsonb_build_object('serverSlug',js.slug,'weight',pse.weight) ORDER BY js.slug)
                       FROM plan_server_eligibility pse JOIN jellyfin_servers js ON js.id=pse.server_id
                       WHERE pse.plan_id=p.id
                   ),'[]'::jsonb) AS server_pool
            FROM plans p ORDER BY p.sort_order,p.price_minor,p.name
        `),
        query(`SELECT event_type,telegram_enabled,email_enabled FROM notification_preferences ORDER BY event_type`)
    ]);

    const settings = {};
    for (const row of settingsResult.rows) settings[row.setting_key] = normalizeSetting(row.setting_key, row.setting_value);
    const plans = plansResult.rows.map(row => normalizePlan({ ...row, serverPool: row.server_pool || [] }, 0));
    const notifications = notificationsResult.rows.map((row, index) => normalizeNotification(row, index));

    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        configuration: { settings, plans, notifications },
        excluded: [
            'administrator/customer identities and passwords',
            'Jellyfin API keys and server URLs',
            'payment provider credentials and price mappings',
            'subscriptions, payment events and redemption history',
            'customer-specific policy/library overrides',
            'sessions, audit events, provisioning history and activity data'
        ]
    };
}

function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable);
    if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key])]));
    return value;
}

async function previewImport(document) {
    const normalized = parseDocument(document);
    const [existingPlans, serverRows, settingsRows, notificationRows] = await Promise.all([
        query('SELECT code FROM plans'),
        query('SELECT slug FROM jellyfin_servers'),
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key = ANY($1::text[])`, [Object.keys(normalized.configuration.settings)]),
        query('SELECT event_type,telegram_enabled,email_enabled FROM notification_preferences')
    ]);
    const planSet = new Set(existingPlans.rows.map(row => String(row.code).toLowerCase()));
    const serverSet = new Set(serverRows.rows.map(row => String(row.slug).toLowerCase()));
    const currentSettings = Object.fromEntries(settingsRows.rows.map(row => [row.setting_key, row.setting_value]));
    const currentNotifications = new Map(notificationRows.rows.map(row => [String(row.event_type).toLowerCase(), row]));

    const missingServers = [];
    const poolPlansBlocked = [];
    for (const plan of normalized.configuration.plans) {
        const missing = plan.serverPool.filter(entry => !serverSet.has(entry.serverSlug.toLowerCase())).map(entry => entry.serverSlug);
        if (missing.length) {
            missingServers.push(...missing.map(serverSlug => ({ planCode: plan.code, serverSlug })));
            poolPlansBlocked.push(plan.code);
        }
    }

    let settingChanges = 0;
    for (const [key, value] of Object.entries(normalized.configuration.settings)) {
        const current = key === 'storefront_features'
            ? (Array.isArray(currentSettings[key]) ? currentSettings[key] : [])
            : normalizeSetting(key, currentSettings[key] || {});
        if (JSON.stringify(comparable(current)) !== JSON.stringify(comparable(value))) settingChanges++;
    }

    let notificationChanges = 0;
    for (const item of normalized.configuration.notifications) {
        const current = currentNotifications.get(item.event_type.toLowerCase());
        if (!current || current.telegram_enabled !== item.telegram_enabled || current.email_enabled !== item.email_enabled) notificationChanges++;
    }

    return {
        document: normalized,
        digest: digestDocument(normalized),
        summary: {
            plansCreate: normalized.configuration.plans.filter(plan => !planSet.has(plan.code.toLowerCase())).length,
            plansUpdate: normalized.configuration.plans.filter(plan => planSet.has(plan.code.toLowerCase())).length,
            settingsChange: settingChanges,
            notificationsChange: notificationChanges,
            serverPoolsApply: normalized.configuration.plans.length - new Set(poolPlansBlocked).size,
            serverPoolsSkipped: new Set(poolPlansBlocked).size
        },
        warnings: missingServers.map(item => `Plan ${item.planCode}: server pool references missing server slug ${item.serverSlug}; that plan's existing pool will be left unchanged.`)
    };
}

async function applyImport(document, actorUserId) {
    const preview = await previewImport(document);
    const normalized = preview.document;
    const serverRows = await query('SELECT id,slug FROM jellyfin_servers');
    const serverMap = new Map(serverRows.rows.map(row => [String(row.slug).toLowerCase(), row]));

    const result = await transaction(async client => {
        for (const [key, value] of Object.entries(normalized.configuration.settings)) {
            await client.query(`
                INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
                VALUES($1,$2::jsonb,$3,NOW())
                ON CONFLICT(setting_key) DO UPDATE SET
                    setting_value=CASE WHEN $1='storefront_features' THEN EXCLUDED.setting_value ELSE platform_settings.setting_value || EXCLUDED.setting_value END,
                    updated_by=EXCLUDED.updated_by,updated_at=NOW()
            `, [key, JSON.stringify(value), actorUserId || null]);
        }

        for (const item of normalized.configuration.notifications) {
            await client.query(`
                INSERT INTO notification_preferences(event_type,telegram_enabled,email_enabled,updated_by,updated_at)
                VALUES($1,$2,$3,$4,NOW())
                ON CONFLICT(event_type) DO UPDATE SET
                    telegram_enabled=EXCLUDED.telegram_enabled,email_enabled=EXCLUDED.email_enabled,
                    updated_by=EXCLUDED.updated_by,updated_at=NOW()
            `, [item.event_type, item.telegram_enabled, item.email_enabled, actorUserId || null]);
        }

        let poolsApplied = 0;
        let poolsSkipped = 0;
        for (const plan of normalized.configuration.plans) {
            const saved = await client.query(`
                INSERT INTO plans(
                    code,name,description,audience,billing_interval,duration_days,price_minor,currency,streams,
                    allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,
                    allow_4k,allow_remuxing,allow_remote_access,server_class,active,visible,sort_order,
                    library_access_mode,library_names,placement_strategy,
                    created_at,updated_at
                ) VALUES(
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::text[],$24,NOW(),NOW()
                )
                ON CONFLICT(code) DO UPDATE SET
                    name=EXCLUDED.name,description=EXCLUDED.description,audience=EXCLUDED.audience,
                    billing_interval=EXCLUDED.billing_interval,duration_days=EXCLUDED.duration_days,
                    price_minor=EXCLUDED.price_minor,currency=EXCLUDED.currency,streams=EXCLUDED.streams,
                    allow_downloads=EXCLUDED.allow_downloads,allow_video_transcoding=EXCLUDED.allow_video_transcoding,
                    allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,allow_live_tv=EXCLUDED.allow_live_tv,
                    allow_live_tv_management=EXCLUDED.allow_live_tv_management,allow_4k=EXCLUDED.allow_4k,
                    allow_remuxing=EXCLUDED.allow_remuxing,allow_remote_access=EXCLUDED.allow_remote_access,
                    server_class=EXCLUDED.server_class,active=EXCLUDED.active,visible=EXCLUDED.visible,
                    sort_order=EXCLUDED.sort_order,
                    library_access_mode=EXCLUDED.library_access_mode,library_names=EXCLUDED.library_names,
                    placement_strategy=EXCLUDED.placement_strategy,updated_at=NOW()
                RETURNING id
            `, [
                plan.code, plan.name, plan.description, plan.audience, plan.billing_interval, plan.duration_days,
                plan.price_minor, plan.currency, plan.streams, plan.allow_downloads, plan.allow_video_transcoding,
                plan.allow_audio_transcoding, plan.allow_live_tv, plan.allow_live_tv_management, plan.allow_4k,
                plan.allow_remuxing, plan.allow_remote_access, plan.server_class, plan.active, plan.visible, plan.sort_order,
                plan.library_access_mode, plan.library_names,
                plan.placement_strategy
            ]);
            const planId = saved.rows[0].id;
            const missing = plan.serverPool.some(entry => !serverMap.has(entry.serverSlug.toLowerCase()));
            if (missing) {
                poolsSkipped++;
                continue;
            }
            await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
            for (const entry of plan.serverPool) {
                const server = serverMap.get(entry.serverSlug.toLowerCase());
                await client.query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight,created_at,updated_at) VALUES($1,$2,$3,NOW(),NOW())`, [planId, server.id, entry.weight]);
            }
            poolsApplied++;
        }

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.configuration.import','configuration',$2,$3::jsonb)
        `, [actorUserId || null, preview.digest, JSON.stringify({ ...preview.summary, poolsApplied, poolsSkipped, version: VERSION })]);
        return { ...preview.summary, poolsApplied, poolsSkipped };
    });

    return { digest: preview.digest, summary: result, warnings: preview.warnings };
}

module.exports = {
    FORMAT,
    VERSION,
    MAX_DOCUMENT_BYTES,
    ConfigurationValidationError,
    parseDocument,
    digestDocument,
    exportPortableConfiguration,
    previewImport,
    applyImport,
    normalizeSetting,
    normalizePlan
};
