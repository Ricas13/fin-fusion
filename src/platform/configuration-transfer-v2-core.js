'use strict';

const crypto = require('crypto');
const v1 = require('./configuration-transfer-v1');
const { query } = require('../db');

const FORMAT = v1.FORMAT || 'steam-fusion-portable-configuration';
const VERSION = 2;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const EXTRA_SETTINGS = ['trial_free_policy', 'commerce_policy'];
const V1_SETTINGS = new Set(['platform', 'storefront', 'storefront_features', 'admin_defaults', 'referral_program']);

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
            plans: document.configuration?.plans || [],
            notifications: document.configuration?.notifications || []
        },
        excluded: document.excluded || []
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
    const plans = base.configuration.plans.map(plan => {
        const extra = inputPlanByCode.get(String(plan.code).toLowerCase()) || {};
        return {
            ...plan,
            request_movie_quota_limit: integer(extra.request_movie_quota_limit, 0, 100000, true, `${plan.code}.request_movie_quota_limit`),
            request_movie_quota_days: integer(extra.request_movie_quota_days, 1, 3650, true, `${plan.code}.request_movie_quota_days`),
            request_tv_quota_limit: integer(extra.request_tv_quota_limit, 0, 100000, true, `${plan.code}.request_tv_quota_limit`),
            request_tv_quota_days: integer(extra.request_tv_quota_days, 1, 3650, true, `${plan.code}.request_tv_quota_days`)
        };
    });

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
    const base = await v1.exportPortableConfiguration();
    const [quotaRows, extraSettings, directMappings, automation] = await Promise.all([
        query(`SELECT code,request_movie_quota_limit,request_movie_quota_days,request_tv_quota_limit,request_tv_quota_days FROM plans ORDER BY code`),
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key`, [EXTRA_SETTINGS]),
        query(`SELECT p.code plan_code,pp.provider,pp.checkout_mode,pp.external_id,pp.active,pp.metadata FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id ORDER BY p.code,pp.provider,pp.checkout_mode`),
        query(`SELECT job_key,enabled,interval_seconds FROM automation_job_state ORDER BY job_key`)
    ]);

    const quotas = new Map(quotaRows.rows.map(row => [String(row.code), row]));

    const settings = { ...base.configuration.settings };
    for (const row of extraSettings.rows) settings[row.setting_key] = row.setting_value;

    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        configuration: {
            settings,
            plans: base.configuration.plans.map(plan => ({ ...plan, ...(quotas.get(plan.code) || {}) })),
            notifications: base.configuration.notifications,
            directPaymentMappings: directMappings.rows.map(mapping => ({
                planCode: mapping.plan_code,
                provider: mapping.provider,
                checkoutMode: mapping.checkout_mode,
                externalId: mapping.external_id,
                active: mapping.active,
                metadata: mapping.metadata || {}
            })),
            automation: automation.rows.map(job => ({
                jobKey: job.job_key,
                enabled: job.enabled,
                intervalSeconds: Number(job.interval_seconds)
            }))
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
    previewImport
};
