'use strict';

const {query}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const planPolicy=require('../entitlements/plan-lifecycle-policy');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');
const provisioning=require('../jellyfin/resilient-provisioning');

const HOLD_TYPE='inactivity_policy';

function asDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}

// Free Server has one intentionally small state machine:
//   1. The allocation/re-allocation timestamp starts the clock.
//   2. No playback by firstPlaybackGraceDays => remove.
//   3. Once playback exists, after playbackWindowDays from allocation, keep only
//      users who meet minimumPlaybackMinutes inside the rolling playback window.
// Login/LastActivityDate never counts as playback and never resets this clock.
function assessUsage(row,policy,now=Date.now()){
  const startsAt=asDate(row.starts_at);
  const accountCreatedAt=asDate(row.account_created_at);
  const allocationStartAt=asDate(row.allocation_start_at)||accountCreatedAt||startsAt;
  const rawFirstPlaybackAt=asDate(row.first_playback_at);
  const rawLastPlaybackAt=asDate(row.last_playback_at);
  let firstPlaybackAt=rawFirstPlaybackAt&&(!allocationStartAt||rawFirstPlaybackAt.getTime()>=allocationStartAt.getTime())?rawFirstPlaybackAt:null;
  const lastPlaybackAt=rawLastPlaybackAt&&(!allocationStartAt||rawLastPlaybackAt.getTime()>=allocationStartAt.getTime())?rawLastPlaybackAt:null;
  if(!firstPlaybackAt&&lastPlaybackAt)firstPlaybackAt=lastPlaybackAt;
  const hasPlayback=Boolean(firstPlaybackAt||lastPlaybackAt);
  const allocationAgeHours=allocationStartAt?Math.max(0,(now-allocationStartAt.getTime())/3600000):0;
  const seconds=Math.max(0,Number(row.playback_seconds||0));
  const graceDays=Number(policy.firstPlaybackGraceDays||0);
  const windowDays=Number(policy.playbackWindowDays||policy.noPlaybackDays||0);
  const minimumMinutes=Number(policy.minimumPlaybackMinutes||0);
  const firstPlaybackEligible=!hasPlayback&&graceDays>0&&allocationAgeHours>=Math.max(Number(policy.minimumObservationHours||0),graceDays*24);
  const usageEligible=hasPlayback&&windowDays>0&&minimumMinutes>0&&allocationAgeHours>=Math.max(Number(policy.minimumObservationHours||0),windowDays*24)&&seconds<minimumMinutes*60;
  return{
    allocationStartAt,
    firstPlaybackAt,
    lastPlaybackAt,
    lastActivityAt:null,
    hasPlayback,
    referenceAt:lastPlaybackAt||allocationStartAt,
    observationStartedAt:allocationStartAt,
    activationAgeHours:allocationAgeHours,
    ageHours:allocationAgeHours,
    seconds,
    firstPlaybackEligible,
    noPlaybackEligible:hasPlayback&&usageEligible&&seconds===0,
    usageEligible
  };
}

async function candidates(globalCfg=null,{customerId=null}={}){
  globalCfg=globalCfg||await lifecyclePolicy.get();
  if(!globalCfg.enabled)return[];
  const result=await query(`
    WITH free_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.id subscription_id,s.plan_id,s.starts_at,s.current_period_end,s.source subscription_source,
        p.code plan_code,p.name plan_name,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND p.is_free_tier=TRUE AND p.price_minor=0
        AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND ($2::uuid IS NULL OR s.customer_id=$2::uuid)
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    )
    SELECT fa.*,ja.id account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at account_created_at,
      allocation.allocation_start_at,js.name server_name,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,
      us.first_playback_at,us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.jellyfin_account_id=ja.id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=fa.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||fa.plan_id::text) AND h.released_at IS NULL) already_held
    FROM free_access fa
    JOIN customers c ON c.id=fa.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    JOIN jellyfin_accounts ja ON ja.customer_id=fa.customer_id AND ja.account_purpose='jellyfin' AND ja.access_lane='free' AND ja.disabled=FALSE
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN LATERAL (
      SELECT MAX(jal.restored_at) FILTER(WHERE jal.restored_at<=NOW()) restored_at
      FROM jellyfin_account_lifecycle jal
      WHERE jal.customer_id=fa.customer_id AND jal.category='free' AND jal.restored_at IS NOT NULL
        AND jal.metadata->>'restoredReason'='admin_reenable'
        AND jal.metadata->>'explicitRestore'='true'
    ) lifecycle ON TRUE
    LEFT JOIN LATERAL (
      SELECT GREATEST(
        fa.starts_at,
        ja.created_at,
        COALESCE(ja.access_lane_changed_at,ja.created_at),
        COALESCE(lifecycle.restored_at,'epoch'::timestamptz)
      ) allocation_start_at
    ) allocation ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(ph.started_at) FILTER(WHERE ph.started_at>=allocation.allocation_start_at) first_playback_at,
             MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) FILTER(WHERE ph.started_at>=allocation.allocation_start_at) last_playback_at,
             COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))))
               FILTER(WHERE ph.started_at>=GREATEST(allocation.allocation_start_at,NOW()-(COALESCE(NULLIF(fa.inactivity_policy->>'playbackWindowDays','')::int,$3)||' days')::interval)),0)::bigint playback_seconds
      FROM playback_history ph
      WHERE ph.customer_id=fa.customer_id AND ph.server_id=ja.server_id
        AND (ph.jellyfin_account_id=ja.id OR ph.jellyfin_account_id IS NULL)
    ) us ON TRUE
    WHERE NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=fa.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,allocation.allocation_start_at),customer_name
  `,[HOLD_TYPE,customerId||null,globalCfg.freePlaybackWindowDays||7]);

  return result.rows.map(row=>{
    const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg);
    const assessment=assessUsage(row,policy);
    const usageTriggered=!assessment.hasPlayback?assessment.firstPlaybackEligible:assessment.usageEligible;
    const eligible=policy.enabled&&!row.automation_protected&&!row.currently_playing&&usageTriggered;
    const triggers=[];
    if(assessment.firstPlaybackEligible)triggers.push(`no Free Server playback within ${policy.firstPlaybackGraceDays} day(s) of allocation`);
    if(assessment.usageEligible)triggers.push(`${Math.round(assessment.seconds/60)} min played on Free Server in the last ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`);
    return{
      ...row,
      policy,
      first_playback_at:assessment.firstPlaybackAt,
      last_playback_at:assessment.lastPlaybackAt,
      last_activity_at:null,
      allocation_start_at:assessment.allocationStartAt,
      playback_seconds:assessment.seconds,
      inactive_reference_at:assessment.referenceAt,
      observation_started_at:assessment.observationStartedAt,
      has_playback:assessment.hasPlayback,
      eligible,
      repairExistingHold:Boolean(row.already_held&&eligible),
      triggers,
      reasons:eligible?triggers:[
        !policy.enabled?'Free Server usage rules disabled':null,
        row.automation_protected?'admin protected':null,
        row.currently_playing?'currently playing on Free Server':null,
        !usageTriggered?(assessment.hasPlayback?'minimum rolling playback requirement is satisfied or the 7-day window has not elapsed':'3-day first-play grace period has not expired'):null
      ].filter(Boolean)
    };
  }).filter(row=>policyConfigured(row.policy));
}

function policyConfigured(policy){
  return Boolean(policy&&policy.firstPlaybackGraceDays!=null&&policy.minimumPlaybackMinutes!=null&&policy.playbackWindowDays!=null);
}

async function releaseObsoletePlanHolds(actorUserId=null,globalCfg=null){
  globalCfg=globalCfg||await lifecyclePolicy.get();
  const rows=await query(`SELECT h.customer_id,h.source_key,p.inactivity_policy,p.is_free_tier,p.price_minor,p.service_type,EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=h.customer_id AND s.plan_id=p.id AND s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()) active_subscription FROM customer_access_holds h LEFT JOIN plans p ON h.source_key=('plan:'||p.id::text) WHERE h.hold_type=$1 AND h.released_at IS NULL`,[HOLD_TYPE]);
  let released=0;
  for(const row of rows.rows){
    const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg);
    const keep=Boolean(row.active_subscription&&row.is_free_tier&&Number(row.price_minor||0)===0&&['jellyfin','bundle'].includes(String(row.service_type||'jellyfin'))&&policyConfigured(policy));
    if(keep)continue;
    await accessHolds.releaseHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:row.source_key,actorUserId});
    await provisioning.reconcileCustomer(row.customer_id).catch(()=>{});
    released++;
  }
  return released;
}

module.exports={HOLD_TYPE,asDate,assessUsage,policyConfigured,candidates,releaseObsoletePlanHolds};
