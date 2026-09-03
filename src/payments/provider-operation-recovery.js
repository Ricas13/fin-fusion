'use strict';

const Stripe = require('stripe');
const { query, transaction } = require('../db');
const buildInfo = require('../build-info');
const providerOps = require('./provider-operations');
const providerSettings = require('./provider-settings');
const providerPricing = require('./provider-plan-pricing');
const providerHttp = require('./provider-http');
const billingControl = require('./billing-control');

const PLAN_OPERATION_TYPES = ['plan_change_immediate','plan_change_schedule'];
const RENEWAL_OPERATION_TYPES = ['renewal_stop','renewal_resume'];
const REFUND_OPERATION_TYPES = ['prorata_refund'];
const TERMINATION_OPERATION_TYPES = ['subscription_terminate'];
const MAX_AUTOMATIC_ATTEMPTS = 12;

function manual(message) { const error = new Error(message); error.providerOperationManual = true; return error; }
function superseded(message) { const error = new Error(message); error.providerOperationSuperseded = true; return error; }
function stripePriceId(subscription) { const price = subscription?.items?.data?.[0]?.price; return typeof price === 'string' ? price : price?.id || null; }
function stripeResourceMissing(error) {
  const status = Number(error?.statusCode || error?.raw?.statusCode || error?.raw?.status || 0);
  const code = String(error?.code || error?.raw?.code || '');
  return status === 404 || code === 'resource_missing';
}
function scheduleTargetPrice(schedule) {
  let target = null;
  for (const phase of schedule?.phases || []) for (const item of phase?.items || []) {
    const price = typeof item.price === 'string' ? item.price : item.price?.id;
    if (price) target = price;
  }
  return target;
}
async function stripeClient() {
  const cfg = await providerSettings.get('stripe');
  const key = cfg.restrictedKey || cfg.apiKey || '';
  if (!key) throw manual('Stripe is not configured, so the provider operation cannot be verified automatically.');
  return new Stripe(key, { apiVersion:'2026-06-24.dahlia', appInfo:buildInfo.providerAppInfo(), timeout:providerHttp.timeoutMs('stripe') });
}
async function assertNewest(op, types) {
  const newer = await providerOps.newerOperation(op, { operationTypes:types });
  if (newer) throw superseded(`Superseded by newer ${newer.operation_type} operation ${newer.id}.`);
}
function contractSnapshot(target, mapping) {
  return {
    kind:'direct_plan',provider:'stripe',planId:target.id,planPriceId:mapping.plan_price_id||null,
    planCode:target.code,planName:target.name,priceMinor:Number(mapping.price_minor),discountedMinor:Number(mapping.price_minor),
    currency:String(mapping.currency).toUpperCase(),billingInterval:target.billing_interval,durationDays:Number(target.duration_days||30),
    streams:Number(target.streams||1),allowDownloads:Boolean(target.allow_downloads),allowVideoTranscoding:Boolean(target.allow_video_transcoding),
    allowAudioTranscoding:Boolean(target.allow_audio_transcoding),allowLiveTv:Boolean(target.allow_live_tv),allowLiveTvManagement:Boolean(target.allow_live_tv_management),
    serverClass:target.server_class,requestMovieQuotaLimit:target.request_movie_quota_limit==null?null:Number(target.request_movie_quota_limit),
    requestMovieQuotaDays:target.request_movie_quota_days==null?null:Number(target.request_movie_quota_days),requestTvQuotaLimit:target.request_tv_quota_limit==null?null:Number(target.request_tv_quota_limit),
    requestTvQuotaDays:target.request_tv_quota_days==null?null:Number(target.request_tv_quota_days),checkoutMode:'subscription',
    providerMappingId:mapping.external_id||null,providerMappingRecordId:mapping.provider_mapping_id||null
  };
}
async function loadTarget(request) {
  const targetResult = await query('SELECT * FROM plans WHERE id=$1', [request.targetPlanId]);
  const target = targetResult.rows[0];
  if (!target) throw manual('Target plan no longer exists.');
  const mapping = await providerPricing.getProviderPlanByExternalId('stripe', request.targetPriceId);
  if (!mapping || String(mapping.id) !== String(target.id) || mapping.checkout_mode !== 'subscription') throw manual('Target Stripe price no longer maps to the intended plan.');
  return { target, mapping };
}
async function applyPlanSnapshot(db, subscriptionId, target, mapping) {
  const snapshot = contractSnapshot(target, mapping);
  await db.query(`UPDATE subscriptions SET plan_id=$2,provider_price_id_snapshot=$3,plan_name_snapshot=$4,plan_code_snapshot=$5,price_minor_snapshot=$6,currency_snapshot=$7,billing_interval_snapshot=$8,duration_days_snapshot=$9,commercial_snapshot=$10::jsonb,plan_price_id_snapshot=$11,provider_mapping_id_snapshot=$12,provider_mapping_external_id_snapshot=$3,updated_at=NOW() WHERE id=$1`, [subscriptionId,target.id,mapping.external_id,target.name,target.code,Number(mapping.price_minor),String(mapping.currency).toUpperCase(),target.billing_interval,Number(target.duration_days||30),JSON.stringify(snapshot),mapping.plan_price_id||null,mapping.provider_mapping_id||null]);
}
async function finishImmediateLocal(op, subscription, target, mapping) {
  await transaction(async db => {
    const locked = (await db.query('SELECT * FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE', [subscription.id,op.owner_id])).rows[0];
    if (!locked) throw manual('Local subscription disappeared during provider recovery.');
    await assertNewest(op, PLAN_OPERATION_TYPES);
    await applyPlanSnapshot(db, locked.id, target, mapping);
    const updated = await db.query(`UPDATE provider_operations SET state='local_applied',local_applied_at=COALESCE(local_applied_at,NOW()),last_error=NULL,failure_kind=NULL,manual_review_required=FALSE,next_attempt_at=NOW()+($2::int*INTERVAL '1 second'),updated_at=NOW() WHERE id=$1 AND attempt_count=$3 RETURNING id`, [op.id,providerOps.ACTIVE_LEASE_SECONDS,op.attempt_count]);
    if (!updated.rowCount) throw providerOps.leaseLost(op.id);
  });
}
async function recoverImmediate(op) {
  await assertNewest(op, PLAN_OPERATION_TYPES);
  const request = op.request_snapshot || {};
  const subscriptionId = request.subscriptionId || op.local_reference;
  if (!subscriptionId || !request.targetPlanId || !request.targetPriceId) throw manual('Immediate plan-change recovery snapshot is incomplete.');
  const subscription = (await query('SELECT * FROM subscriptions WHERE id=$1 AND customer_id=$2', [subscriptionId,op.owner_id])).rows[0];
  if (!subscription) throw manual('Plan-change subscription no longer exists.');
  const { target, mapping } = await loadTarget(request);
  const client = await stripeClient();
  let remote = await client.subscriptions.retrieve(subscription.provider_subscription_id, { expand:['items.data.price'] });
  let observedPrice = stripePriceId(remote);
  await providerOps.observed(op.id, { result:{observedPrice,status:remote.status||null} });
  if (observedPrice !== request.targetPriceId) {
    if (['provider_applied','local_applied'].includes(op.state)) throw manual('Stripe no longer reflects the already-applied target price; refusing to overwrite a later provider decision.');
    const item = remote.items?.data?.[0];
    if (!item?.id) throw manual('Stripe subscription has no editable item.');
    remote = await client.subscriptions.update(subscription.provider_subscription_id, {
      items:[{id:item.id,price:request.targetPriceId}],
      proration_behavior:request.proration?'create_prorations':'none',
      metadata:{...(remote.metadata||{}),internal_customer_id:String(op.owner_id),internal_plan_id:String(request.targetPlanId),internal_plan_price_id:String(request.targetPlanPriceId||'')}
    }, { idempotencyKey:op.idempotency_key });
    observedPrice = stripePriceId(remote);
    if (observedPrice !== request.targetPriceId) throw manual('Stripe accepted recovery but did not expose the intended target price.');
  }
  if (op.state === 'planned') await providerOps.providerApplied(op.id, { providerReference:remote.id, result:{priceId:observedPrice,status:remote.status||null,recovered:true} });
  if (op.state !== 'local_applied') await finishImmediateLocal(op, subscription, target, mapping);
  const synced = await billingControl.syncSubscription(subscription.id, { expectedProviderPriceId:request.targetPriceId });
  if (!synced.ok) throw new Error(`Recovered local plan change but provider verification is still failing: ${synced.error}`);
  await providerOps.reconciled(op.id, { result:{subscriptionId:subscription.id,targetPlanId:target.id,targetPlanPriceId:mapping.plan_price_id,recovered:true} });
  return { ok:true,type:op.operation_type,id:op.id };
}
async function matchingSchedule(client, remote, op, request) {
  let schedule = remote.schedule || null;
  if (typeof schedule === 'string') schedule = await client.subscriptionSchedules.retrieve(schedule);
  if (!schedule && op.provider_reference) {
    try {
      schedule = await client.subscriptionSchedules.retrieve(op.provider_reference);
    } catch (error) {
      if (!stripeResourceMissing(error)) throw error;
    }
  }
  if (!schedule) return null;
  const owner = String(schedule.metadata?.internal_customer_id || '');
  const changeId = String(schedule.metadata?.captainfin_plan_change_id || '');
  if (owner && owner !== String(op.owner_id)) return null;
  if (changeId && changeId !== String(request.changeId)) return null;
  return schedule;
}
async function ensureScheduleRemote(op, request) {
  const client = await stripeClient();
  let remote = await client.subscriptions.retrieve(request.subscriptionId, { expand:['items.data.price','schedule'] });
  let schedule = await matchingSchedule(client, remote, op, request);
  if (schedule) {
    await providerOps.observed(op.id, { result:{scheduleId:schedule.id,scheduleStatus:schedule.status||null,targetPrice:scheduleTargetPrice(schedule)} });
    return { client,remote,schedule,sourcePrice:op.provider_result?.sourcePrice||stripePriceId(remote) };
  }
  if (['provider_applied','local_applied'].includes(op.state)) throw manual('Recorded Stripe schedule is no longer observable; refusing to recreate it automatically.');
  if (remote.schedule) throw manual('Stripe subscription now has a different schedule; manual review is required.');
  const item = remote.items?.data?.[0];
  const sourcePrice = stripePriceId(remote);
  if (!item?.id || !sourcePrice) throw manual('Stripe subscription has no editable recurring price.');
  const start = Number(item.current_period_start);
  const end = Number(item.current_period_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Math.floor(Date.now()/1000)) throw manual('Stripe did not return a future billing boundary for recovery.');
  schedule = await client.subscriptionSchedules.create({ from_subscription:request.subscriptionId }, { idempotencyKey:`${op.idempotency_key}:create` });
  const phaseStart = Number(schedule.current_phase?.start_date || start);
  const quantity = Math.max(1, Number(item.quantity || 1));
  schedule = await client.subscriptionSchedules.update(schedule.id, {
    end_behavior:'release',proration_behavior:'none',
    metadata:{...(schedule.metadata||{}),internal_customer_id:String(op.owner_id),captainfin_plan_change_id:String(request.changeId),target_plan_id:String(request.targetPlanId),target_plan_price_id:String(request.targetPlanPriceId||'')},
    phases:[
      {start_date:phaseStart,end_date:end,items:[{price:sourcePrice,quantity}],proration_behavior:'none'},
      {start_date:end,iterations:1,items:[{price:request.targetPriceId,quantity}],proration_behavior:'none',metadata:{internal_customer_id:String(op.owner_id),internal_plan_id:String(request.targetPlanId),internal_plan_price_id:String(request.targetPlanPriceId||'')}}
    ]
  }, { idempotencyKey:`${op.idempotency_key}:phases` });
  return { client,remote,schedule,sourcePrice,effectiveAt:new Date(end*1000).toISOString() };
}
async function recoverSchedule(op) {
  await assertNewest(op, PLAN_OPERATION_TYPES);
  const request = op.request_snapshot || {};
  if (!request.changeId || !request.subscriptionId || !request.targetPlanId || !request.targetPriceId) throw manual('Scheduled plan-change recovery snapshot is incomplete.');
  const change = (await query('SELECT * FROM customer_plan_changes WHERE id=$1 AND customer_id=$2', [request.changeId,op.owner_id])).rows[0];
  if (!change) throw manual('Scheduled local plan-change record no longer exists.');
  const remote = await ensureScheduleRemote(op, request);
  const schedule = remote.schedule;
  if (!schedule?.id) throw manual('Stripe schedule could not be recovered.');
  const target = scheduleTargetPrice(schedule);
  if (target && target !== request.targetPriceId) throw manual('Stripe schedule target no longer matches the intended plan price.');
  if (op.state === 'planned') await providerOps.providerApplied(op.id, { providerReference:schedule.id, result:{scheduleStatus:schedule.status||'active',sourcePrice:remote.sourcePrice,targetPrice:request.targetPriceId,effectiveAt:remote.effectiveAt||op.provider_result?.effectiveAt||null,recovered:true} });
  if (op.state !== 'local_applied') await transaction(async db => {
    const locked = (await db.query('SELECT * FROM customer_plan_changes WHERE id=$1 AND customer_id=$2 FOR UPDATE', [change.id,op.owner_id])).rows[0];
    if (!locked) throw manual('Plan-change record disappeared during recovery.');
    await assertNewest(op, PLAN_OPERATION_TYPES);
    await db.query(`UPDATE customer_plan_changes SET state=CASE WHEN state='failed' THEN 'pending' ELSE state END,provider_schedule_id=$2,provider_schedule_state=$3,source_price_id=COALESCE($4,source_price_id),target_price_id=$5,error=NULL,updated_at=NOW() WHERE id=$1`, [change.id,schedule.id,schedule.status||'active',remote.sourcePrice||null,request.targetPriceId]);
    const updated = await db.query(`UPDATE provider_operations SET state='local_applied',local_applied_at=COALESCE(local_applied_at,NOW()),last_error=NULL,failure_kind=NULL,manual_review_required=FALSE,next_attempt_at=NOW()+($2::int*INTERVAL '1 second'),updated_at=NOW() WHERE id=$1 AND attempt_count=$3 RETURNING id`, [op.id,providerOps.ACTIVE_LEASE_SECONDS,op.attempt_count]);
    if (!updated.rowCount) throw providerOps.leaseLost(op.id);
  });
  await providerOps.reconciled(op.id, { result:{changeId:change.id,scheduleId:schedule.id,targetPlanId:request.targetPlanId,recovered:true} });
  return { ok:true,type:op.operation_type,id:op.id };
}
async function recoverOne(op) {
  if (op.attempt_count >= MAX_AUTOMATIC_ATTEMPTS) throw manual(`Automatic recovery exhausted after ${op.attempt_count} attempts.`);
  if (op.operation_type === 'plan_change_immediate') return recoverImmediate(op);
  if (op.operation_type === 'plan_change_schedule') return recoverSchedule(op);
  if (op.operation_type === 'prorata_refund') return require('./prorata-refunds').recoverProviderOperation(op);
  if (RENEWAL_OPERATION_TYPES.includes(op.operation_type) && typeof billingControl.recoverProviderOperation === 'function') return billingControl.recoverProviderOperation(op);
  if (TERMINATION_OPERATION_TYPES.includes(op.operation_type)) return require('./subscription-termination').recoverProviderOperation(op);
  throw manual(`No recovery handler exists for provider operation type ${op.operation_type}.`);
}
async function run({ limit=25 } = {}) {
  const claimed = await providerOps.claimRecoverable({ limit });
  const summary = { total:claimed.length,reconciled:0,retryable:0,manual:0,superseded:0,stale:0,failed:0,results:[] };
  for (const op of claimed) {
    await providerOps.withRecoveryClaim(op, async () => {
      try {
        const result = await recoverOne(op);
        summary.reconciled++;
        summary.results.push(result);
      } catch (error) {
        if (error.providerOperationLeaseLost) {
          summary.stale++;
          summary.results.push({ok:false,id:op.id,stale:true,error:error.message});
          return;
        }
        try {
          if (error.providerOperationSuperseded) {
            await providerOps.markSuperseded(op.id,error); summary.superseded++; summary.results.push({ok:false,id:op.id,superseded:true,error:error.message}); return;
          }
          if (error.providerOperationManual) {
            await providerOps.markManual(op.id,error); summary.manual++; summary.results.push({ok:false,id:op.id,manual:true,error:error.message}); return;
          }
          const updated = await providerOps.recordError(op.id,error);
          if (updated?.manual_review_required) summary.manual++; else summary.retryable++;
          summary.failed++;
          summary.results.push({ok:false,id:op.id,error:error.message,failureKind:updated?.failure_kind||null});
        } catch (writeError) {
          if (writeError.providerOperationLeaseLost) {
            summary.stale++;
            summary.results.push({ok:false,id:op.id,stale:true,error:writeError.message});
            return;
          }
          throw writeError;
        }
      }
    });
  }
  return { ...summary,processed:summary.total,failed:summary.failed+summary.manual };
}
async function attention({ limit=100 } = {}) { return providerOps.open({ limit }); }

module.exports = { PLAN_OPERATION_TYPES,RENEWAL_OPERATION_TYPES,REFUND_OPERATION_TYPES,TERMINATION_OPERATION_TYPES,MAX_AUTOMATIC_ATTEMPTS,recoverOne,run,attention };