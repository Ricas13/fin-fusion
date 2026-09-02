'use strict';

const primitives = require('./lifecycle-primitives');
const billingMode = require('./subscription-billing-mode');
const { query, transaction } = require('../db');
const state = require('../entitlements/subscription-state');
const serviceScope = require('../entitlements/service-scope');
const capacity = require('../entitlements/plan-capacity');
const inactivityHolds = require('../entitlements/inactivity-hold-reconciliation');
const planExpiry = require('../entitlements/plan-expiry');
const commerce = require('./commerce-control');
const stremio = require('../stremio/foundation');

function addPlanDuration(plan, from = new Date()) {
    return planExpiry.endForPlan(plan, { now: from });
}
function permanentEnd() { return planExpiry.freeTierEnd(); }
function availableWindowSql(alias='p'){return `${alias}.active=TRUE AND ${alias}.visible=TRUE AND ${alias}.archived_at IS NULL AND (${alias}.effective_from IS NULL OR ${alias}.effective_from<=NOW()) AND (${alias}.effective_until IS NULL OR ${alias}.effective_until>NOW())`;}
function checkoutBillingMode(input){return billingMode.normalize(input?.commercialSnapshot?.checkoutMode);}
function validRemoteRecurringId(provider,value){
    const source=String(provider||'').trim().toLowerCase(),id=String(value||'').trim();
    // This validates the remote API object family only. Persisted local
    // recurring truth is billing_mode and must never be inferred from this ID.
    if(source==='stripe')return /^sub_/i.test(id);
    if(source==='paypal')return /^I-/i.test(id);
    return false;
}

async function getProviderOptions(planCode, provider) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND ${availableWindowSql('p')}
          AND ${capacity.acquisitionSql('p')}
          AND p.audience IN ('direct','both')
          AND pp.provider=$2 AND pp.active=TRUE
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
    `, [planCode, provider]);
    return result.rows;
}

async function getProviderPlan(planCode, provider, checkoutMode = null) {
    const mode = checkoutMode && ['payment','subscription'].includes(checkoutMode) ? checkoutMode : null;
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND ${availableWindowSql('p')}
          AND ${capacity.acquisitionSql('p')}
          AND p.audience IN ('direct','both')
          AND pp.provider=$2 AND pp.active=TRUE
          AND ($3::text IS NULL OR pp.checkout_mode=$3)
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
        LIMIT 1
    `, [planCode, provider, mode]);
    const plan=result.rows[0]||null;
    if(plan)stremio.assertAcquirable(plan,{context:`new ${provider} checkout`});
    return plan;
}

async function getProviderPlanByExternalId(provider, externalId) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata,pp.active AS mapping_active
        FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id
        WHERE pp.provider=$1 AND pp.external_id=$2
          AND p.audience IN ('direct','both')
        ORDER BY pp.updated_at DESC
        LIMIT 1
    `, [provider, externalId]);
    return result.rows[0] || null;
}

async function assertDirectPlan(planCode, { free = false, trial = false } = {}) {
    const result = await query(`SELECT * FROM plans p WHERE p.code=$1 AND ${availableWindowSql('p')} AND ${capacity.acquisitionSql('p')} LIMIT 1`, [String(planCode || '').trim()]);
    if (!result.rowCount) throw new Error('Plan is not available or is currently sold out.');
    const plan = state.assertAudience(result.rows[0], 'customer');
    stremio.assertAcquirable(plan,{context:trial?'new trial':free?'new free claim':'new customer acquisition'});
    if (free && (!planExpiry.isFreeTier(plan) || Number(plan.price_minor) !== 0 || plan.billing_interval === 'trial')) throw new Error('This free plan is not available.');
    if (trial && plan.billing_interval !== 'trial') throw new Error('This trial is not available.');
    return plan;
}

async function trialPolicy() {
    const result = await query(`SELECT setting_value FROM platform_settings WHERE setting_key='trial_free_policy'`);
    const value = result.rows[0]?.setting_value || {};
    return {
        trialMode: ['once_ever','once_per_plan','before_paid'].includes(value.trialMode) ? value.trialMode : 'once_ever',
        freeMode: ['once_per_plan','renewable','permanent'].includes(value.freeMode) ? value.freeMode : 'once_per_plan',
        // Compatibility property: Free Server is now an independent access lane,
        // so paid Jellyfin never blocks a legitimate Free Server claim.
        paidCanClaimFree: true,
        downgradeToFree: value.downgradeToFree === true,
        downgradeFreePlanCode: String(value.downgradeFreePlanCode || '').trim()
    };
}

async function saveTrialPolicy(input, actorUserId = null) {
    const value = {
        trialMode: ['once_ever','once_per_plan','before_paid'].includes(input.trialMode) ? input.trialMode : 'once_ever',
        freeMode: ['once_per_plan','renewable','permanent'].includes(input.freeMode) ? input.freeMode : 'once_per_plan',
        paidCanClaimFree: true,
        downgradeToFree: input.downgradeToFree === true,
        downgradeFreePlanCode: String(input.downgradeFreePlanCode || '').trim()
    };
    if (value.downgradeToFree) {
        const target = await query(`SELECT code FROM plans p WHERE code=$1 AND ${availableWindowSql('p')} AND is_free_tier=TRUE AND price_minor=0 AND billing_interval<>'trial' AND audience IN ('direct','both')`, [value.downgradeFreePlanCode]);
        if (!target.rowCount) throw new Error('Choose an active direct free plan for automatic downgrade.');
        stremio.assertAcquirable((await query('SELECT service_type FROM plans WHERE code=$1',[value.downgradeFreePlanCode])).rows[0],{context:'automatic free downgrade'});
    } else value.downgradeFreePlanCode = '';
    await transaction(async client => {
        await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('trial_free_policy',$1::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [JSON.stringify(value)]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.commerce.trial_free_policy','platform_setting','trial_free_policy',$2::jsonb)`, [actorUserId, JSON.stringify(value)]);
    });
    return value;
}

async function enforceTrialEligibility(customerId, plan) {
    const policy = await trialPolicy();
    if (policy.trialMode === 'once_per_plan') {
        const prior = await query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 LIMIT 1`, [customerId, plan.id]);
        if (prior.rowCount) throw new Error('This trial has already been used.');
        return policy;
    }
    const priorTrial = await query(`SELECT s.service_type_snapshot,p.service_type,p.name
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1 AND COALESCE(s.billing_interval_snapshot,p.billing_interval)='trial'`, [customerId]);
    if (priorTrial.rows.some(row=>serviceScope.overlaps(row,plan))) throw new Error(`A ${serviceScope.label(plan)} trial has already been used on this account.`);
    if (policy.trialMode === 'before_paid') {
        const paid = await query(`SELECT s.service_type_snapshot,p.service_type,p.name
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND COALESCE(s.billing_interval_snapshot,p.billing_interval)<>'trial' AND COALESCE(s.price_minor_snapshot,p.price_minor)>0`, [customerId]);
        if (paid.rows.some(row=>serviceScope.overlaps(row,plan))) throw new Error(`${serviceScope.label(plan)} trials are only available before the first paid subscription for that service.`);
    }
    return policy;
}

async function startFreeTrial(customerId, planCode) {
    await commerce.assertOpen();
    const plan = await assertDirectPlan(planCode, { trial: true });
    if(plan.is_addon)throw new Error('Trial access must use a primary plan, not an add-on.');
    await enforceTrialEligibility(customerId, plan);
    const created = await transaction(async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
        await capacity.lockAndAssert(client,plan.id,plan.name||'This trial');
        const live = await client.query(`
            SELECT s.id,s.service_type_snapshot,p.service_type,p.name,p.is_free_tier
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
            WHERE s.customer_id=$1 AND COALESCE(p.is_addon,FALSE)=FALSE
              AND s.superseded_by IS NULL AND s.starts_at<=NOW()
              AND (
                (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
                OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
                OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end + ((s.service_extension_days || ' days')::interval))>NOW())
              )
            FOR UPDATE OF s
        `, [customerId]);
        const conflict=live.rows.find(row=>serviceScope.overlaps(row,plan)&&!serviceScope.isFreeTier(row));
        if (conflict) throw new Error(`You already have active ${serviceScope.label(conflict)} access. Change or cancel that service before starting another overlapping trial.`);
        const startsAt = new Date(), endsAt = addPlanDuration(plan, startsAt);
        const row = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'trialing','manual',$3,$4) RETURNING *`, [customerId, plan.id, startsAt, endsAt]);
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('subscription.trial.start','subscription',$1,$2::jsonb)`, [row.rows[0].id, JSON.stringify({ customerId, planCode: plan.code, serviceType: serviceScope.serviceType(plan) })]);
        return row.rows[0];
    });
    await inactivityHolds.releaseObsoleteForCustomer(customerId);
    await primitives.reconcileCommittedCustomer(customerId, 'Trial');
    return created;
}

async function reservedFreePlan(reservationId){
    if(!reservationId)return null;
    const result=await query(`SELECT p.* FROM free_access_registration_reservations r JOIN plans p ON p.id=r.plan_id WHERE r.id=$1 AND r.consumed_at IS NULL AND r.released_at IS NULL AND r.expires_at>NOW() AND ${availableWindowSql('p')} LIMIT 1`,[reservationId]);
    if(!result.rowCount)return null;
    const plan=state.assertAudience(result.rows[0],'customer');
    stremio.assertAcquirable(plan,{context:'reserved free claim'});
    if(!planExpiry.isFreeTier(plan)||Number(plan.price_minor)!==0||plan.billing_interval==='trial'||plan.is_addon)throw new Error('This Free Access reservation is not valid.');
    return plan;
}

async function claimFreePlan(customerId, planCode, { automatic = false, reservationId = null } = {}) {
    if(!automatic)await commerce.assertOpen();
    const plan = reservationId ? await reservedFreePlan(reservationId) : await assertDirectPlan(planCode, { free: true });
    if(!plan)throw new Error('Your Free Access hold has expired.');
    if(plan.is_addon)throw new Error('Free primary access cannot be claimed from an add-on product.');
    const policy = await trialPolicy();
    const created = await transaction(async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
        let reservation=null;
        if(reservationId){
            reservation=(await client.query(`SELECT * FROM free_access_registration_reservations WHERE id=$1 FOR UPDATE`,[reservationId])).rows[0]||null;
            if(!reservation||reservation.consumed_at||reservation.released_at||new Date(reservation.expires_at).getTime()<=Date.now()||String(reservation.plan_id)!==String(plan.id))throw new Error('Your Free Access hold has expired.');
        }
        await capacity.lockAndAssert(client,plan.id,plan.name||'This free plan',{excludeReservationId:reservationId});
        const historical = await client.query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim' LIMIT 1`,[customerId,plan.id]);
        const liveFree = await client.query(`
            SELECT s.id,s.plan_id
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND s.source='free_claim' AND p.is_free_tier=TRUE
              AND COALESCE(p.is_addon,FALSE)=FALSE AND s.superseded_by IS NULL
              AND s.starts_at<=NOW() AND s.status IN('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
            FOR UPDATE OF s
        `,[customerId]);
        if(liveFree.rows.some(row=>String(row.plan_id)===String(plan.id)))throw new Error('You already have free access on this plan.');
        if(policy.freeMode!=='renewable'&&historical.rowCount)throw new Error('Free access on this plan has already been claimed.');
        const startsAt=new Date(),endsAt=permanentEnd();
        const row=await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',$3,$4) RETURNING *`,[customerId,plan.id,startsAt,endsAt]);
        for(const old of liveFree.rows)await state.markSuperseded(client,{subscriptionId:old.id,replacementId:row.rows[0].id,reason:automatic?'automatic_free_downgrade':'free_plan_change'});
        if(reservation)await client.query(`UPDATE free_access_registration_reservations SET consumed_at=NOW(),customer_id=$2,subscription_id=$3,updated_at=NOW() WHERE id=$1`,[reservation.id,customerId,row.rows[0].id]);
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'subscription',$2,$3::jsonb)`,[automatic?'subscription.free.auto_downgrade':'subscription.free.claim',row.rows[0].id,JSON.stringify({customerId,planCode:plan.code,startsAt,endsAt,freeMode:policy.freeMode,nonExpiring:true,parallelWithPaid:true,reservationId:reservation?.id||null})]);
        return row.rows[0];
    });
    await inactivityHolds.releaseObsoleteForCustomer(customerId);
    await primitives.reconcileCommittedCustomer(customerId, automatic ? 'Automatic free plan' : 'Free plan');
    return created;
}

async function autoDowngradeEligibleCustomer(customerId) {
    const policy = await trialPolicy();
    if (!policy.downgradeToFree || !policy.downgradeFreePlanCode) return null;
    // The configured downgrade target is always a Jellyfin free plan (enforced
    // by admin-jellyfin-plan-editor.js), so eligibility must be scoped to the
    // customer's Jellyfin/bundle lane. An unrelated live Stremio-only
    // entitlement must never suppress a Jellyfin free-tier downgrade.
    const live = await state.effectiveSubscription(customerId, { includeBlocked: true });
    if (live) return null;
    try { return await claimFreePlan(customerId, policy.downgradeFreePlanCode, { automatic: true }); }
    catch (error) {
        if (/already been claimed|sold out|not available/i.test(error.message)) return null;
        throw error;
    }
}

async function activatePurchase(input) {
    const planResult = await query('SELECT * FROM plans WHERE id=$1', [input.planId]);
    if (!planResult.rowCount) throw new Error('Plan not found.');
    const plan=state.assertAudience(planResult.rows[0], 'customer');
    const same = input.providerSubscriptionId ? await query(`SELECT id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 LIMIT 1`, [input.provider,input.providerSubscriptionId]) : {rowCount:0};
    if(!same.rowCount)stremio.assertAcquirable(plan,{context:'paid subscription activation'});
    const mode=checkoutBillingMode(input);
    if (billingMode.isRecurring({ source: input.provider, billing_mode: mode })) {
        if (!same.rowCount) await state.assertNoOtherLiveRecurring({ query }, input.customerId, null, plan.id);
    }
    const activated=await primitives.activatePurchase(input);
    const released=await inactivityHolds.releaseObsoleteForCustomer(input.customerId);
    if(released)await primitives.reconcileCommittedCustomer(input.customerId,'Paid plan');
    return activated;
}

async function attachDiscoveredProviderSubscription({
    subscriptionId,
    provider,
    providerCustomerId = null,
    providerSubscriptionId,
    providerStatus,
    periodEnd = null,
    cancelAtPeriodEnd = false,
    externalPlanIds = [],
    actorUserId = null,
    matchReason = null
}) {
    provider = String(provider || '').toLowerCase();
    providerSubscriptionId = String(providerSubscriptionId || '').trim();
    if (!validRemoteRecurringId(provider,providerSubscriptionId)) throw new Error('A valid Stripe or PayPal recurring subscription is required.');
    const remotePlanIds = Array.from(new Set((externalPlanIds || []).map(value => String(value || '').trim()).filter(Boolean)));
    if (!remotePlanIds.length) throw new Error('Provider subscription has no plan/price identity to verify.');

    const attached = await transaction(async client => {
        const localResult = await client.query(`
            SELECT s.*,p.is_addon,p.is_free_tier,
                   COALESCE(NULLIF(s.commercial_snapshot->>'serverClass',''),p.server_class) AS effective_server_class,
                   COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type) AS effective_service_type,
                   COALESCE(s.price_minor_snapshot,p.price_minor,0) AS effective_price_minor
              FROM subscriptions s
              JOIN plans p ON p.id=s.plan_id
             WHERE s.id=$1
             FOR UPDATE
        `, [subscriptionId]);
        const local = localResult.rows[0];
        if (!local) throw new Error('Local premium subscription disappeared.');
        if (local.effective_server_class !== 'premium' || !['jellyfin','bundle'].includes(local.effective_service_type) || Number(local.effective_price_minor) <= 0 || local.is_free_tier) {
            throw new Error('Local subscription is no longer a paid Premium Server entitlement.');
        }
        if (state.recurringProvider(local)) {
            if (local.source === provider && local.provider_subscription_id === providerSubscriptionId) return { row: local, already: true };
            throw new Error('Local subscription became linked to another provider subscription.');
        }

        const duplicate = await client.query(`SELECT id,customer_id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 AND id<>$3 LIMIT 1 FOR UPDATE`, [provider, providerSubscriptionId, local.id]);
        if (duplicate.rowCount) throw new Error('Provider subscription is already attached to another local subscription.');
        await state.assertNoOtherLiveRecurring(client, local.customer_id, local.id, local.plan_id);

        const mapping = await client.query(`
            SELECT id,external_id,plan_price_id
              FROM plan_provider_prices
             WHERE provider=$1 AND checkout_mode='subscription' AND plan_id=$2
               AND external_id=ANY($3::text[])
             ORDER BY active DESC,updated_at DESC
             LIMIT 1
        `, [provider, local.plan_id, remotePlanIds]);
        if (!mapping.rowCount) throw new Error('Provider subscription no longer maps to the local premium plan.');
        const providerMap = mapping.rows[0];
        const status = primitives.mapProviderStatus(provider, providerStatus);
        if (!['active','trialing','past_due','paused'].includes(status)) throw new Error('Provider subscription is not in a current state that can be linked automatically.');

        const updated = await client.query(`
            UPDATE subscriptions
               SET source=$2,billing_mode='subscription',
                   provider_customer_id=COALESCE($3,provider_customer_id),
                   provider_subscription_id=$4,
                   provider_price_id_snapshot=COALESCE($5,provider_price_id_snapshot),
                   plan_price_id_snapshot=COALESCE($6,plan_price_id_snapshot),
                   provider_mapping_id_snapshot=COALESCE($7,provider_mapping_id_snapshot),
                   provider_mapping_external_id_snapshot=COALESCE($5,provider_mapping_external_id_snapshot),
                   status=$8,current_period_end=COALESCE($9,current_period_end),
                   cancel_at_period_end=$10,updated_at=NOW()
             WHERE id=$1
             RETURNING *
        `, [local.id, provider, providerCustomerId || null, providerSubscriptionId, providerMap.external_id || null, providerMap.plan_price_id || null, providerMap.id || null, status, periodEnd ? new Date(periodEnd) : null, Boolean(cancelAtPeriodEnd)]);
        const row = updated.rows[0];
        await primitives.syncProviderAccessState({ customerId: row.customer_id, provider, providerSubscriptionId, status, billingMode: row.billing_mode }, client);

        const now = new Date(), next = new Date(now.getTime() + 6 * 60 * 60 * 1000);
        await client.query(`
            INSERT INTO subscription_provider_sync(subscription_id,provider,remote_status,remote_period_end,remote_cancel_at_period_end,last_attempt_at,last_success_at,last_error,consecutive_failures,next_attempt_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$6,NULL,0,$7,NOW())
            ON CONFLICT(subscription_id) DO UPDATE SET
                provider=EXCLUDED.provider,remote_status=EXCLUDED.remote_status,
                remote_period_end=EXCLUDED.remote_period_end,remote_cancel_at_period_end=EXCLUDED.remote_cancel_at_period_end,
                last_attempt_at=EXCLUDED.last_attempt_at,last_success_at=EXCLUDED.last_success_at,
                last_error=NULL,consecutive_failures=0,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=NOW()
        `, [row.id, provider, String(providerStatus || ''), periodEnd ? new Date(periodEnd) : null, Boolean(cancelAtPeriodEnd), now, next]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.billing.subscription_discovery.link','subscription',$2,$3::jsonb)`, [actorUserId, row.id, JSON.stringify({ customerId: row.customer_id, provider, providerCustomerId, providerSubscriptionId, billingMode: row.billing_mode, providerPlanIds: remotePlanIds, providerMappingId: providerMap.id, providerMappingExternalId: providerMap.external_id, remoteStatus: providerStatus, matchReason })]);
        return { row, already: false };
    });

    if (providerCustomerId) await primitives.ensurePaymentCustomer({ customerId: attached.row.customer_id, provider, providerCustomerId });
    await primitives.reconcileCommittedCustomer(attached.row.customer_id, 'Provider subscription discovery');
    return attached;
}

module.exports = {
    ...primitives,
    getProviderOptions,
    getProviderPlan,
    getProviderPlanByExternalId,
    startFreeTrial,
    claimFreePlan,
    activatePurchase,
    attachDiscoveredProviderSubscription,
    trialPolicy,
    saveTrialPolicy,
    autoDowngradeEligibleCustomer,
    availableWindowSql
};