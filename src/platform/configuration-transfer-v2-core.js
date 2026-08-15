'use strict';

const crypto = require('crypto');
const v1 = require('./configuration-transfer-v1');
const { query, transaction } = require('../db');

const FORMAT = v1.FORMAT || 'steam-fusion-portable-configuration';
const VERSION = 2;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const EXTRA_SETTINGS = ['reseller_defaults_v2', 'trial_free_policy', 'commerce_policy'];
const V1_SETTINGS = new Set(['platform', 'storefront', 'storefront_features', 'reseller_defaults', 'admin_defaults', 'referral_program']);

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

function normalizeTier(source, index) {
    const path = `resellerTiers[${index}]`;
    const code = text(source?.code, 50).toLowerCase();
    const name = text(source?.name, 80);
    const currency = text(source?.currency, 3).toUpperCase();
    if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)) throw new v1.ConfigurationValidationError('Invalid reseller tier code.', `${path}.code`);
    if (!name) throw new v1.ConfigurationValidationError('Tier name is required.', `${path}.name`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new v1.ConfigurationValidationError('Invalid currency.', `${path}.currency`);

    const providerMappings = Array.isArray(source?.providerMappings)
        ? source.providerMappings.slice(0, 4).map((mapping, mappingIndex) => {
            const provider = text(mapping?.provider, 20);
            const externalId = text(mapping?.externalId, 200);
            if (!['stripe', 'paypal'].includes(provider)) {
                throw new v1.ConfigurationValidationError('Unsupported reseller provider.', `${path}.providerMappings[${mappingIndex}].provider`);
            }
            if (!externalId) throw new v1.ConfigurationValidationError('Provider mapping ID is required.', `${path}.providerMappings[${mappingIndex}].externalId`);
            return { provider, externalId, active: mapping.active !== false };
        })
        : [];

    const planRules = Array.isArray(source?.planRules)
        ? source.planRules.slice(0, 500).map(rule => ({
            planCode: text(rule?.planCode, 80),
            allowCustomer: rule?.allowCustomer !== false,
            allowOwner: rule?.allowOwner !== false,
            allowTrial: rule?.allowTrial === true,
            active: rule?.active !== false
        })).filter(rule => rule.planCode)
        : [];

    return {
        code,
        name,
        description: text(source?.description, 500),
        monthly_price_minor: integer(source?.monthly_price_minor, 0, 100000000, false, `${path}.monthly_price_minor`),
        currency,
        seat_limit: integer(source?.seat_limit, 1, 100000, false, `${path}.seat_limit`),
        grace_days: integer(source?.grace_days ?? 0, 0, 30, false, `${path}.grace_days`),
        sort_order: integer(source?.sort_order ?? 100, 0, 10000, false, `${path}.sort_order`),
        visible: source?.visible !== false,
        active: source?.active !== false,
        providerMappings,
        planRules
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
            resellerTiers: (Array.isArray(parsed.configuration.resellerTiers) ? parsed.configuration.resellerTiers : []).map(normalizeTier),
            directPaymentMappings: normalizeDirectMappings(parsed.configuration.directPaymentMappings),
            automation: normalizeAutomation(parsed.configuration.automation)
        },
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded.slice(0, 100).map(value => text(value, 200)) : []
    };
}

async function exportPortableConfiguration() {
    const base = await v1.exportPortableConfiguration();
    const [quotaRows, extraSettings, tiers, tierMappings, rules, directMappings, automation] = await Promise.all([
        query(`SELECT code,request_movie_quota_limit,request_movie_quota_days,request_tv_quota_limit,request_tv_quota_days FROM plans ORDER BY code`),
        query(`SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key`, [EXTRA_SETTINGS]),
        query(`SELECT id,code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active FROM reseller_tiers ORDER BY sort_order,code`),
        query(`SELECT tier_id,provider,external_id,active FROM reseller_tier_provider_prices ORDER BY tier_id,provider`),
        query(`SELECT rr.tier_id,p.code plan_code,rr.active,rr.allow_customer,rr.allow_owner,rr.allow_trial FROM reseller_tier_plan_rules rr JOIN plans p ON p.id=rr.plan_id ORDER BY rr.tier_id,p.code`),
        query(`SELECT p.code plan_code,pp.provider,pp.checkout_mode,pp.external_id,pp.active,pp.metadata FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id ORDER BY p.code,pp.provider,pp.checkout_mode`),
        query(`SELECT job_key,enabled,interval_seconds FROM automation_job_state ORDER BY job_key`)
    ]);

    const quotas = new Map(quotaRows.rows.map(row => [String(row.code), row]));
    const providerByTier = new Map();
    const rulesByTier = new Map();
    for (const row of tierMappings.rows) {
        const key = String(row.tier_id);
        if (!providerByTier.has(key)) providerByTier.set(key, []);
        providerByTier.get(key).push({ provider: row.provider, externalId: row.external_id, active: row.active });
    }
    for (const row of rules.rows) {
        const key = String(row.tier_id);
        if (!rulesByTier.has(key)) rulesByTier.set(key, []);
        rulesByTier.get(key).push({
            planCode: row.plan_code,
            active: row.active,
            allowCustomer: row.allow_customer,
            allowOwner: row.allow_owner,
            allowTrial: row.allow_trial
        });
    }

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
            resellerTiers: tiers.rows.map(tier => ({
                code: tier.code,
                name: tier.name,
                description: tier.description,
                monthly_price_minor: Number(tier.monthly_price_minor),
                currency: String(tier.currency).trim(),
                seat_limit: Number(tier.seat_limit),
                grace_days: Number(tier.grace_days || 0),
                sort_order: Number(tier.sort_order),
                visible: tier.visible,
                active: tier.active,
                providerMappings: providerByTier.get(String(tier.id)) || [],
                planRules: rulesByTier.get(String(tier.id)) || []
            })),
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
            'customers/resellers/subscriptions/payment transactions',
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
    const [existingTiers, existingPlans] = await Promise.all([
        query('SELECT code FROM reseller_tiers'),
        query('SELECT code FROM plans')
    ]);
    const tierCodes = new Set(existingTiers.rows.map(row => String(row.code).toLowerCase()));
    const planCodes = new Set(existingPlans.rows.map(row => String(row.code).toLowerCase()));
    const importedPlanCodes = new Set(document.configuration.plans.map(plan => String(plan.code).toLowerCase()));
    const warnings = [...(basePreview.warnings || [])];
    for (const mapping of document.configuration.directPaymentMappings) {
        if (!planCodes.has(mapping.planCode.toLowerCase()) && !importedPlanCodes.has(mapping.planCode.toLowerCase())) warnings.push(`Payment mapping skipped unless plan ${mapping.planCode} exists after import.`);
    }
    for (const tier of document.configuration.resellerTiers) {
        for (const rule of tier.planRules) {
            if (!planCodes.has(rule.planCode.toLowerCase()) && !importedPlanCodes.has(rule.planCode.toLowerCase())) warnings.push(`Tier ${tier.code} references missing plan ${rule.planCode}.`);
        }
    }
    return {
        document,
        digest: digestDocument(document),
        warnings: [...new Set(warnings)],
        summary: {
            ...basePreview.summary,
            resellerTiersCreate: document.configuration.resellerTiers.filter(tier => !tierCodes.has(tier.code.toLowerCase())).length,
            resellerTiersUpdate: document.configuration.resellerTiers.filter(tier => tierCodes.has(tier.code.toLowerCase())).length,
            directPaymentMappings: document.configuration.directPaymentMappings.length,
            automationJobs: document.configuration.automation.length,
            extendedSettings: EXTRA_SETTINGS.filter(key => Object.prototype.hasOwnProperty.call(document.configuration.settings, key)).length
        }
    };
}

async function applyImport(input, actorUserId = null) {
    const document = parseDocument(input);
    if (document.version === 1) return v1.applyImport(document, actorUserId);

    const preview = await previewImport(document);
    const base = await v1.applyImport(asV1(document), actorUserId);
    const summary = await transaction(async client => {
        for (const plan of document.configuration.plans) {
            await client.query(`
                UPDATE plans SET
                    request_movie_quota_limit=$2,request_movie_quota_days=$3,
                    request_tv_quota_limit=$4,request_tv_quota_days=$5,updated_at=NOW()
                WHERE code=$1
            `, [plan.code, plan.request_movie_quota_limit, plan.request_movie_quota_days, plan.request_tv_quota_limit, plan.request_tv_quota_days]);
        }

        for (const key of EXTRA_SETTINGS) {
            if (!Object.prototype.hasOwnProperty.call(document.configuration.settings, key)) continue;
            await client.query(`
                INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
                VALUES($1,$2::jsonb,$3,NOW())
                ON CONFLICT(setting_key) DO UPDATE SET
                  setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()
            `, [key, JSON.stringify(document.configuration.settings[key]), actorUserId]);
        }

        for (const tier of document.configuration.resellerTiers) {
            await client.query(`
                INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                ON CONFLICT(code) DO UPDATE SET
                  name=EXCLUDED.name,description=EXCLUDED.description,monthly_price_minor=EXCLUDED.monthly_price_minor,
                  currency=EXCLUDED.currency,seat_limit=EXCLUDED.seat_limit,grace_days=EXCLUDED.grace_days,
                  sort_order=EXCLUDED.sort_order,visible=EXCLUDED.visible,
                  active=CASE WHEN reseller_tiers.active=FALSE AND EXCLUDED.active=TRUE THEN TRUE ELSE reseller_tiers.active END,
                  updated_at=NOW()
            `, [tier.code,tier.name,tier.description,tier.monthly_price_minor,tier.currency,tier.seat_limit,tier.grace_days,tier.sort_order,tier.visible,tier.active]);
        }

        const tierRows = await client.query('SELECT id,code FROM reseller_tiers');
        const planRows = await client.query('SELECT id,code FROM plans');
        const tierByCode = new Map(tierRows.rows.map(row => [String(row.code).toLowerCase(), row]));
        const planByCode = new Map(planRows.rows.map(row => [String(row.code).toLowerCase(), row]));

        let tierMappingsApplied = 0;
        let tierRulesApplied = 0;
        let skippedReferences = 0;
        for (const tier of document.configuration.resellerTiers) {
            const savedTier = tierByCode.get(tier.code.toLowerCase());
            if (!savedTier) continue;
            for (const mapping of tier.providerMappings) {
                await client.query(`
                    INSERT INTO reseller_tier_provider_prices(tier_id,provider,external_id,active)
                    VALUES($1,$2,$3,$4)
                    ON CONFLICT(tier_id,provider) DO UPDATE SET
                      external_id=EXCLUDED.external_id,active=EXCLUDED.active,updated_at=NOW()
                `, [savedTier.id,mapping.provider,mapping.externalId,mapping.active]);
                tierMappingsApplied++;
            }
            for (const rule of tier.planRules) {
                const savedPlan = planByCode.get(rule.planCode.toLowerCase());
                if (!savedPlan) { skippedReferences++; continue; }
                await client.query(`
                    INSERT INTO reseller_tier_plan_rules(tier_id,plan_id,active,allow_customer,allow_owner,allow_trial,updated_at)
                    VALUES($1,$2,$3,$4,$5,$6,NOW())
                    ON CONFLICT(tier_id,plan_id) DO UPDATE SET
                      active=EXCLUDED.active,allow_customer=EXCLUDED.allow_customer,
                      allow_owner=EXCLUDED.allow_owner,allow_trial=EXCLUDED.allow_trial,updated_at=NOW()
                `, [savedTier.id,savedPlan.id,rule.active,rule.allowCustomer,rule.allowOwner,rule.allowTrial]);
                tierRulesApplied++;
            }
        }

        let directMappingsApplied = 0;
        for (const mapping of document.configuration.directPaymentMappings) {
            const savedPlan = planByCode.get(mapping.planCode.toLowerCase());
            if (!savedPlan) { skippedReferences++; continue; }
            await client.query(`
                INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active,metadata)
                VALUES($1,$2,$3,$4,$5,$6::jsonb)
                ON CONFLICT(plan_id,provider,checkout_mode) DO UPDATE SET
                  external_id=EXCLUDED.external_id,active=EXCLUDED.active,metadata=EXCLUDED.metadata,updated_at=NOW()
            `, [savedPlan.id,mapping.provider,mapping.externalId,mapping.checkoutMode,mapping.active,JSON.stringify(mapping.metadata || {})]);
            directMappingsApplied++;
        }

        let automationApplied = 0;
        for (const job of document.configuration.automation) {
            const result = await client.query(`
                UPDATE automation_job_state SET enabled=$2,interval_seconds=$3,next_run_at=LEAST(COALESCE(next_run_at,NOW()),NOW()),updated_at=NOW()
                WHERE job_key=$1
            `, [job.jobKey,job.enabled,job.intervalSeconds]);
            if (result.rowCount) automationApplied++;
            else skippedReferences++;
        }

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.configuration.import.v2','configuration',$2,$3::jsonb)
        `, [actorUserId,preview.digest,JSON.stringify({ ...preview.summary,tierMappingsApplied,tierRulesApplied,directMappingsApplied,automationApplied,skippedReferences })]);

        return { tierMappingsApplied,tierRulesApplied,directMappingsApplied,automationApplied,skippedReferences };
    });

    return {
        digest: preview.digest,
        warnings: preview.warnings,
        summary: { ...(base.summary || {}), ...preview.summary, ...summary }
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
    applyImport
};
