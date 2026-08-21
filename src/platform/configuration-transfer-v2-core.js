'use strict';

const crypto = require('crypto');
const v1 = require('./configuration-transfer-v1');
const { query } = require('../db');

const FORMAT = v1.FORMAT || 'steam-fusion-portable-configuration';
const VERSION = 2;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const EXTRA_SETTINGS = ['trial_free_policy', 'commerce_policy'];
const V1_SETTINGS = new Set(['platform', 'storefront', 'storefront_features', 'admin_defaults', 'referral_program']);
const SERVICE_TYPES = new Set(['jellyfin', 'stremio', 'bundle']);
const JELLYFIN_ACCESS_MODELS = new Set(['concurrent_streams', 'household_network']);

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function integer(value, min, max, nullable = true, path = '') {
    if ((value === null || value === undefined || value === '') && nullable) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new v1.ConfigurationValidationError(`Expected integer between ${min} and ${max}.`, path || undefined);
    }
    return parsed;
}
function enumValue(value, allowed, fallback, path) {
    if (value === null || value === undefined || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (!allowed.has(normalized)) throw new v1.ConfigurationValidationError(`Unsupported value: ${String(value)}`, path);
    return normalized;
}
function boolean(value, fallback, path) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new v1.ConfigurationValidationError('Expected true or false.', path);
    return value;
}
function digestDocument(document) {
    return crypto.createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex');
}
function v1Settings(settings) {
    return Object.fromEntries(Object.entries(settings || {}).filter(([key]) => V1_SETTINGS.has(key)));
}
function asV1(document) {
    return {
        format: FORMAT,
        version: 1,
        configuration: {
            settings: v1Settings(document.configuration?.settings),
            // V1 requires streams to be an integer. Household-network plans use
            // NULL because concurrent streams are not their enforcement model,
            // so feed the legacy validator a harmless compatibility sentinel.
            plans: (document.configuration?.plans || []).map(plan => ({
                ...plan,
                streams: plan?.streams == null ? 1 : plan.streams
            })),
            notifications: document.configuration?.notifications || []
        },
        excluded: document.excluded || []
    };
}

function quotaFields(source, code) {
    return {
        request_movie_quota_limit: integer(source.request_movie_quota_limit, 0, 100000, true, `${code}.request_movie_quota_limit`),
        request_movie_quota_days: integer(source.request_movie_quota_days, 1, 3650, true, `${code}.request_movie_quota_days`),
        request_tv_quota_limit: integer(source.request_tv_quota_limit, 0, 100000, true, `${code}.request_tv_quota_limit`),
        request_tv_quota_days: integer(source.request_tv_quota_days, 1, 3650, true, `${code}.request_tv_quota_days`)
    };
}

function normalizeV2Plan(basePlan, source) {
    const code = String(basePlan.code || 'plan');
    const hasModularContract = Object.prototype.hasOwnProperty.call(source, 'service_type')
        || Object.prototype.hasOwnProperty.call(source, 'jellyfin_access_model');

    // V2 existed before modular plan fields were added. Those older documents
    // must not acquire guessed service/access values and overwrite a modern
    // destination plan. Keep their original stream value (including NULL) and
    // mark them so the atomic importer updates legacy columns only.
    if (!hasModularContract) {
        return {
            ...basePlan,
            streams: Object.prototype.hasOwnProperty.call(source, 'streams') ? source.streams : basePlan.streams,
            ...quotaFields(source, code),
            _modular_plan_contract: false
        };
    }

    const serviceType = enumValue(source.service_type, SERVICE_TYPES, 'jellyfin', `${code}.service_type`);
    const jellyfinAccessModel = enumValue(source.jellyfin_access_model, JELLYFIN_ACCESS_MODELS, 'concurrent_streams', `${code}.jellyfin_access_model`);
    const hasJellyfin = serviceType === 'jellyfin' || serviceType === 'bundle';
    const householdJellyfin = hasJellyfin && jellyfinAccessModel === 'household_network';
    const streams = serviceType === 'stremio'
        ? 1
        : householdJellyfin
            ? null
            : integer(source.streams == null ? basePlan.streams : source.streams, 1, 50, false, `${code}.streams`);
    const isAddon = boolean(source.is_addon, false, `${code}.is_addon`);
    if (isAddon && serviceType !== 'stremio') {
        throw new v1.ConfigurationValidationError('Independent add-ons must be Stremio-only.', `${code}.is_addon`);
    }

    return {
        ...basePlan,
        service_type: serviceType,
        capacity_limit: integer(source.capacity_limit, 0, 1000000, true, `${code}.capacity_limit`) ?? 0,
        is_addon: isAddon,
        jellyfin_access_model: hasJellyfin ? jellyfinAccessModel : 'concurrent_streams',
        jellyfin_household_network_limit: householdJellyfin
            ? (integer(source.jellyfin_household_network_limit, 1, 10, true, `${code}.jellyfin_household_network_limit`) ?? 1)
            : 1,
        jellyfin_household_lease_minutes: householdJellyfin
            ? (integer(source.jellyfin_household_lease_minutes, 15, 1440, true, `${code}.jellyfin_household_lease_minutes`) ?? 240)
            : 240,
        stremio_household_lease_minutes: serviceType === 'stremio' || serviceType === 'bundle'
            ? (integer(source.stremio_household_lease_minutes, 15, 1440, true, `${code}.stremio_household_lease_minutes`) ?? 240)
            : 240,
        streams,
        ...quotaFields(source, code),
        _modular_plan_contract: true
    };
}

function normalizeDirectMappings(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 1000).map((mapping, index) => {
        const provider = text(mapping?.provider, 20);
        const checkoutMode = text(mapping?.checkoutMode, 20);
        const planCode = text(mapping?.planCode, 80);
        const externalId = text(mapping?.externalId, 200);
        if (!['stripe', 'paypal'].includes(provider)) throw new v1.ConfigurationValidationError('Unsupported payment provider.', `directPaymentMappings[${index}].provider`);
        if (!['payment', 'subscription'].includes(checkoutMode)) throw new v1.ConfigurationValidationError('Unsupported checkout mode.', `directPaymentMappings[${index}].checkoutMode`);
        if (!planCode) throw new v1.ConfigurationValidationError('Plan code is required.', `directPaymentMappings[${index}].planCode`);
        if (!externalId) throw new v1.ConfigurationValidationError('External provider ID is required.', `directPaymentMappings[${index}].externalId`);
        return {
            planCode,
            provider,
            checkoutMode,
            externalId,
            active: mapping?.active !== false,
            metadata: object(mapping?.metadata)
        };
    });
}

function normalizeAutomation(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).map((job, index) => ({
        jobKey: text(job?.jobKey, 100),
        enabled: job?.enabled !== false,
        intervalSeconds: integer(job?.intervalSeconds, 30, 86400, false, `automation[${index}].intervalSeconds`)
    })).filter(job => job.jobKey);
}

function parseDocument(input) {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    if (Buffer.byteLength(raw || '', 'utf8') > MAX_DOCUMENT_BYTES) throw new v1.ConfigurationValidationError('Configuration document exceeds 1 MiB.');
    let parsed;
    try { parsed = typeof input === 'string' ? JSON.parse(input) : input; }
    catch (_) { throw new v1.ConfigurationValidationError('Configuration is not valid JSON.'); }
    if (parsed?.version === 1) return v1.parseDocument(parsed);
    if (!parsed || parsed.format !== FORMAT || parsed.version !== VERSION || !object(parsed.configuration)) {
        throw new v1.ConfigurationValidationError(`Expected ${FORMAT} version ${VERSION}.`);
    }

    const base = v1.parseDocument(asV1(parsed));
    const inputPlans = Array.isArray(parsed.configuration.plans) ? parsed.configuration.plans : [];
    const inputPlanByCode = new Map(inputPlans.map(plan => [String(plan?.code || '').toLowerCase(), plan]));
    const plans = base.configuration.plans.map(plan => normalizeV2Plan(
        plan,
        inputPlanByCode.get(String(plan.code).toLowerCase()) || {}
    ));

    const settings = { ...base.configuration.settings };
    for (const key of EXTRA_SETTINGS) {
        if (Object.prototype.hasOwnProperty.call(parsed.configuration.settings || {}, key)) settings[key] = object(parsed.configuration.settings[key]);
    }

    return {
        format: FORMAT,
        version: VERSION,
        configuration: {
            settings,
            plans,
            notifications: base.configuration.notifications,
            directPaymentMappings: normalizeDirectMappings(parsed.configuration.directPaymentMappings),
            automation: normalizeAutomation(parsed.configuration.automation)
        },
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded.slice(0, 100).map(value => text(value, 200)) : []
    };
}

async function exportPortableConfiguration() {
    // Do not call the V1 exporter here: it validates streams before V2 can
    // represent household plans, and household plans intentionally store NULL.
    // Read the shared legacy fields directly, validate those through V1 with a
    // compatibility sentinel, then restore/validate the modular V2 contract.
    const settingKeys = [...V1_SETTINGS, ...EXTRA_SETTINGS];
    const [settingsResult, plansResult, notificationsResult, directMappingsResult, automationResult] = await Promise.all([
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key`, [settingKeys]),
        query(`
            SELECT p.code,p.name,p.description,p.audience,p.billing_interval,p.duration_days,p.price_minor,p.currency,
                   p.streams,p.allow_downloads,p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,
                   p.allow_live_tv_management,p.allow_4k,p.allow_remuxing,p.allow_remote_access,p.server_class,p.active,
                   p.visible,p.sort_order,p.library_access_mode,p.library_names,p.placement_strategy,
                   p.service_type,p.capacity_limit,p.is_addon,p.jellyfin_access_model,
                   p.jellyfin_household_network_limit,p.jellyfin_household_lease_minutes,p.stremio_household_lease_minutes,
                   p.request_movie_quota_limit,p.request_movie_quota_days,p.request_tv_quota_limit,p.request_tv_quota_days,
                   COALESCE((
                       SELECT jsonb_agg(jsonb_build_object('serverSlug',js.slug,'weight',pse.weight) ORDER BY js.slug)
                       FROM plan_server_eligibility pse JOIN jellyfin_servers js ON js.id=pse.server_id
                       WHERE pse.plan_id=p.id
                   ),'[]'::jsonb) AS server_pool
            FROM plans p ORDER BY p.sort_order,p.price_minor,p.name
        `),
        query(`SELECT event_type,telegram_enabled,email_enabled FROM notification_preferences ORDER BY event_type`),
        query(`SELECT p.code plan_code,pp.provider,pp.checkout_mode,pp.external_id,pp.active,pp.metadata FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id ORDER BY p.code,pp.provider,pp.checkout_mode`),
        query(`SELECT job_key,enabled,interval_seconds FROM automation_job_state ORDER BY job_key`)
    ]);

    const rawSettings = {};
    for (const row of settingsResult.rows) rawSettings[row.setting_key] = row.setting_value;
    const rawPlans = plansResult.rows.map(row => ({ ...row, serverPool: row.server_pool || [] }));
    const rawDocument = {
        format: FORMAT,
        version: VERSION,
        configuration: {
            settings: rawSettings,
            plans: rawPlans,
            notifications: notificationsResult.rows,
            directPaymentMappings: directMappingsResult.rows.map(mapping => ({
                planCode: mapping.plan_code,
                provider: mapping.provider,
                checkoutMode: mapping.checkout_mode,
                externalId: mapping.external_id,
                active: mapping.active,
                metadata: mapping.metadata || {}
            })),
            automation: automationResult.rows.map(job => ({
                jobKey: job.job_key,
                enabled: job.enabled,
                intervalSeconds: Number(job.interval_seconds)
            }))
        },
        excluded: []
    };

    const legacyValidated = v1.parseDocument(asV1(rawDocument));
    const legacyByCode = new Map(legacyValidated.configuration.plans.map(plan => [String(plan.code).toLowerCase(), plan]));
    const plans = rawPlans.map(source => {
        const normalized = normalizeV2Plan(legacyByCode.get(String(source.code).toLowerCase()), source);
        const { _modular_plan_contract, ...portable } = normalized;
        return portable;
    });
    const settings = { ...legacyValidated.configuration.settings };
    for (const key of EXTRA_SETTINGS) {
        if (Object.prototype.hasOwnProperty.call(rawSettings, key)) settings[key] = object(rawSettings[key]);
    }

    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        configuration: {
            settings,
            plans,
            notifications: legacyValidated.configuration.notifications,
            directPaymentMappings: normalizeDirectMappings(rawDocument.configuration.directPaymentMappings),
            automation: normalizeAutomation(rawDocument.configuration.automation)
        },
        excluded: [
            'payment provider credentials and webhook secrets',
            'Jellyfin URLs/API keys and server identities',
            'customers/subscriptions/payment transactions',
            'sessions/audit/auth history',
            'email/request-service API credentials',
            'branding binary assets'
        ]
    };
}

async function previewImport(input) {
    const document = parseDocument(input);
    if (document.version === 1) return v1.previewImport(document);
    const basePreview = await v1.previewImport(asV1(document));
    const existingPlans = await query('SELECT code FROM plans');
    const planCodes = new Set(existingPlans.rows.map(row => String(row.code).toLowerCase()));
    const importedPlanCodes = new Set(document.configuration.plans.map(plan => String(plan.code).toLowerCase()));
    const warnings = [...(basePreview.warnings || [])];
    for (const mapping of document.configuration.directPaymentMappings) {
        if (!planCodes.has(mapping.planCode.toLowerCase()) && !importedPlanCodes.has(mapping.planCode.toLowerCase())) warnings.push(`Payment mapping skipped unless plan ${mapping.planCode} exists after import.`);
    }
    return {
        document,
        digest: digestDocument(document),
        warnings: [...new Set(warnings)],
        summary: {
            ...basePreview.summary,
            directPaymentMappings: document.configuration.directPaymentMappings.length,
            automationJobs: document.configuration.automation.length,
            extendedSettings: EXTRA_SETTINGS.filter(key => Object.prototype.hasOwnProperty.call(document.configuration.settings, key)).length
        }
    };
}

module.exports = {
    FORMAT,
    VERSION,
    MAX_DOCUMENT_BYTES,
    ConfigurationValidationError: v1.ConfigurationValidationError,
    parseDocument,
    digestDocument,
    exportPortableConfiguration,
    previewImport,
    normalizeV2Plan
};
