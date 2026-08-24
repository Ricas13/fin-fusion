'use strict';

const { transaction } = require('../db');

const V1_SETTINGS = new Set(['platform','storefront','storefront_features','admin_defaults','referral_program']);
const V2_SETTINGS = new Set(['trial_free_policy','commerce_policy','jellyfin_drift_policy','payment_risk_policy','affiliate_program']);
function lower(value) { return String(value || '').toLowerCase(); }

async function applySettings(client, settings, actorUserId) {
    let count = 0;
    for (const [key, value] of Object.entries(settings || {})) {
        if (!V1_SETTINGS.has(key) && !V2_SETTINGS.has(key)) continue;
        await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=CASE WHEN $1='storefront_features' THEN EXCLUDED.setting_value ELSE CASE WHEN jsonb_typeof(platform_settings.setting_value)='object' AND jsonb_typeof(EXCLUDED.setting_value)='object' THEN platform_settings.setting_value||EXCLUDED.setting_value ELSE EXCLUDED.setting_value END END,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [key, JSON.stringify(value), actorUserId || null]);
        count++;
    }
    return count;
}
async function applyNotifications(client, items, actorUserId) {
    let count = 0;
    for (const item of items || []) {
        await client.query(`INSERT INTO notification_preferences(event_type,telegram_enabled,email_enabled,updated_by,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(event_type) DO UPDATE SET telegram_enabled=EXCLUDED.telegram_enabled,email_enabled=EXCLUDED.email_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [item.event_type, item.telegram_enabled, item.email_enabled, actorUserId || null]);
        count++;
    }
    return count;
}

async function saveLegacyPlan(client, plan) {
    // Legacy documents do not own modern service/access columns. Updating an
    // existing row directly avoids constructing an invalid INSERT candidate
    // (for example streams=NULL with the concurrent_streams column default)
    // before ON CONFLICT gets a chance to preserve the modern household model.
    const existing = await client.query('SELECT id FROM plans WHERE code=$1 FOR UPDATE', [plan.code]);
    if (existing.rowCount) {
        return client.query(`UPDATE plans SET name=$2,description=$3,audience=$4,billing_interval=$5,duration_days=$6,price_minor=$7,currency=$8,streams=$9,allow_downloads=$10,allow_video_transcoding=$11,allow_audio_transcoding=$12,allow_live_tv=$13,allow_live_tv_management=$14,allow_4k=$15,allow_remuxing=$16,allow_remote_access=$17,server_class=$18,active=$19,visible=$20,sort_order=$21,library_access_mode=$22,library_names=$23::text[],placement_strategy=$24,updated_at=NOW() WHERE id=$1 RETURNING id`, [existing.rows[0].id,plan.name,plan.description,plan.audience,plan.billing_interval,plan.duration_days,plan.price_minor,plan.currency,plan.streams,plan.allow_downloads,plan.allow_video_transcoding,plan.allow_audio_transcoding,plan.allow_live_tv,plan.allow_live_tv_management,plan.allow_4k,plan.allow_remuxing,plan.allow_remote_access,plan.server_class,plan.active,plan.visible,plan.sort_order,plan.library_access_mode,plan.library_names,plan.placement_strategy]);
    }

    // A brand-new legacy plan has no modern contract to preserve. NULL was a
    // historical sentinel, but a new row defaults to concurrent_streams, so use
    // the fail-safe one-stream value required by the current database contract.
    const safeStreams = plan.streams == null ? 1 : plan.streams;
    return client.query(`INSERT INTO plans(code,name,description,audience,billing_interval,duration_days,price_minor,currency,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,allow_4k,allow_remuxing,allow_remote_access,server_class,active,visible,sort_order,library_access_mode,library_names,placement_strategy,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::text[],$24,NOW(),NOW()) RETURNING id`, [plan.code,plan.name,plan.description,plan.audience,plan.billing_interval,plan.duration_days,plan.price_minor,plan.currency,safeStreams,plan.allow_downloads,plan.allow_video_transcoding,plan.allow_audio_transcoding,plan.allow_live_tv,plan.allow_live_tv_management,plan.allow_4k,plan.allow_remuxing,plan.allow_remote_access,plan.server_class,plan.active,plan.visible,plan.sort_order,plan.library_access_mode,plan.library_names,plan.placement_strategy]);
}

async function saveV2Plan(client, plan) {
    return client.query(`
        INSERT INTO plans(
            code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,
            capacity_limit,is_addon,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,
            allow_live_tv,allow_live_tv_management,allow_4k,allow_remuxing,allow_remote_access,server_class,
            active,visible,sort_order,library_access_mode,library_names,placement_strategy,
            jellyfin_access_model,jellyfin_household_network_limit,jellyfin_household_lease_minutes,
            stremio_household_lease_minutes,created_at,updated_at
        ) VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::text[],$27,$28,$29,$30,$31,NOW(),NOW()
        )
        ON CONFLICT(code) DO UPDATE SET
            name=EXCLUDED.name,description=EXCLUDED.description,service_type=EXCLUDED.service_type,
            audience=EXCLUDED.audience,billing_interval=EXCLUDED.billing_interval,duration_days=EXCLUDED.duration_days,
            price_minor=EXCLUDED.price_minor,currency=EXCLUDED.currency,capacity_limit=EXCLUDED.capacity_limit,
            is_addon=EXCLUDED.is_addon,streams=EXCLUDED.streams,allow_downloads=EXCLUDED.allow_downloads,
            allow_video_transcoding=EXCLUDED.allow_video_transcoding,allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,
            allow_live_tv=EXCLUDED.allow_live_tv,allow_live_tv_management=EXCLUDED.allow_live_tv_management,
            allow_4k=EXCLUDED.allow_4k,allow_remuxing=EXCLUDED.allow_remuxing,allow_remote_access=EXCLUDED.allow_remote_access,
            server_class=EXCLUDED.server_class,active=EXCLUDED.active,visible=EXCLUDED.visible,sort_order=EXCLUDED.sort_order,
            library_access_mode=EXCLUDED.library_access_mode,library_names=EXCLUDED.library_names,
            placement_strategy=EXCLUDED.placement_strategy,jellyfin_access_model=EXCLUDED.jellyfin_access_model,
            jellyfin_household_network_limit=EXCLUDED.jellyfin_household_network_limit,
            jellyfin_household_lease_minutes=EXCLUDED.jellyfin_household_lease_minutes,
            stremio_household_lease_minutes=EXCLUDED.stremio_household_lease_minutes,updated_at=NOW()
        RETURNING id
    `, [
        plan.code,plan.name,plan.description,plan.service_type,plan.audience,plan.billing_interval,plan.duration_days,
        plan.price_minor,plan.currency,plan.capacity_limit,plan.is_addon,plan.streams,plan.allow_downloads,
        plan.allow_video_transcoding,plan.allow_audio_transcoding,plan.allow_live_tv,plan.allow_live_tv_management,
        plan.allow_4k,plan.allow_remuxing,plan.allow_remote_access,plan.server_class,plan.active,plan.visible,
        plan.sort_order,plan.library_access_mode,plan.library_names,plan.placement_strategy,plan.jellyfin_access_model,
        plan.jellyfin_household_network_limit,plan.jellyfin_household_lease_minutes,plan.stremio_household_lease_minutes
    ]);
}

async function applyPlans(client, plans, version = 1) {
    const serverRows = await client.query('SELECT id,slug FROM jellyfin_servers');
    const serverMap = new Map(serverRows.rows.map(row => [lower(row.slug), row]));
    let poolsApplied = 0, poolsSkipped = 0;
    for (const plan of plans || []) {
        // Legacy V1 and pre-modular V2 files intentionally do not own modern
        // modular columns. This prevents an old backup from silently turning
        // Stremio/bundle or household plans back into default Jellyfin plans.
        const ownsModularContract = version === 2 && plan._modular_plan_contract !== false;
        const saved = ownsModularContract ? await saveV2Plan(client, plan) : await saveLegacyPlan(client, plan);
        const planId = saved.rows[0].id;
        if (Object.prototype.hasOwnProperty.call(plan, 'request_movie_quota_limit')) await client.query(`UPDATE plans SET request_movie_quota_limit=$2,request_movie_quota_days=$3,request_tv_quota_limit=$4,request_tv_quota_days=$5,updated_at=NOW() WHERE id=$1`, [planId,plan.request_movie_quota_limit,plan.request_movie_quota_days,plan.request_tv_quota_limit,plan.request_tv_quota_days]);
        const pool = Array.isArray(plan.serverPool) ? plan.serverPool : [], missing = pool.some(entry => !serverMap.has(lower(entry.serverSlug)));
        if (missing) { poolsSkipped++; continue; }
        await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]);
        for (const entry of pool) { const server=serverMap.get(lower(entry.serverSlug)); await client.query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight,created_at,updated_at) VALUES($1,$2,$3,NOW(),NOW())`, [planId, server.id, entry.weight]); }
        poolsApplied++;
    }
    return { poolsApplied, poolsSkipped };
}
async function applyV2Extras(client, configuration) {
    let directMappingsApplied=0,automationApplied=0,skippedReferences=0,mappingsPendingVerification=0;
    const planRows=await client.query('SELECT id,code FROM plans'),planByCode=new Map(planRows.rows.map(row=>[lower(row.code),row]));
    for (const mapping of configuration.directPaymentMappings || []) { const savedPlan=planByCode.get(lower(mapping.planCode));if(!savedPlan){skippedReferences++;continue;}const metadata={...(mapping.metadata||{}),importedRequestedActive:Boolean(mapping.active),requiresRemoteVerification:true};await client.query(`INSERT INTO plan_provider_prices(plan_id,provider,external_id,checkout_mode,active,metadata) VALUES($1,$2,$3,$4,FALSE,$5::jsonb) ON CONFLICT(plan_id,provider,checkout_mode) DO UPDATE SET external_id=EXCLUDED.external_id,active=FALSE,metadata=EXCLUDED.metadata,updated_at=NOW()`,[savedPlan.id,mapping.provider,mapping.externalId,mapping.checkoutMode,JSON.stringify(metadata)]);directMappingsApplied++;if(mapping.active)mappingsPendingVerification++; }
    for (const job of configuration.automation || []) { const result=await client.query(`UPDATE automation_job_state SET enabled=$2,interval_seconds=$3,next_run_at=CASE WHEN $2 THEN LEAST(COALESCE(next_run_at,NOW()),NOW()) ELSE next_run_at END,force_run_requested=CASE WHEN $2 THEN force_run_requested ELSE FALSE END,updated_at=NOW() WHERE job_key=$1`,[job.jobKey,job.enabled,job.intervalSeconds]);if(result.rowCount)automationApplied++;else skippedReferences++; }
    return {directMappingsApplied,automationApplied,skippedReferences,mappingsPendingVerification};
}
async function applyImport(document,{actorUserId=null,digest=null,previewSummary={}}={}) {
    if (!document || !document.configuration) throw new Error('Normalized configuration document is required.');
    return transaction(async client => {
        const settingsApplied=await applySettings(client,document.configuration.settings,actorUserId),notificationsApplied=await applyNotifications(client,document.configuration.notifications,actorUserId),plansResult=await applyPlans(client,document.configuration.plans,document.version),extras=document.version===2?await applyV2Extras(client,document.configuration):{tierMappingsApplied:0,tierPricesApplied:0,tierRulesApplied:0,directMappingsApplied:0,automationApplied:0,skippedReferences:0,mappingsPendingVerification:0};
        const summary={...previewSummary,settingsApplied,notificationsApplied,...plansResult,...extras,atomic:true,version:document.version};
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.configuration.import.atomic','configuration',$2,$3::jsonb)`,[actorUserId||null,digest||'unknown',JSON.stringify(summary)]);
        return summary;
    });
}
module.exports={applyImport,applySettings,applyNotifications,applyPlans,applyV2Extras,saveLegacyPlan,saveV2Plan};
