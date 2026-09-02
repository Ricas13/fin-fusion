'use strict';

const {query}=require('../db');
const provisioning=require('../jellyfin/resilient-provisioning');
const accessHolds=require('../entitlements/access-holds');
const manualAssignment=require('../jellyfin/manual-assignment');

function seconds(value){return Number(value||0)}
function bytes(value){return Number(value||0)}

function buildTimeline(parts){
    return parts.flat().filter(Boolean).sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,150);
}
function primaryFirst(rows,primaryEntitlement){const primaryId=String(primaryEntitlement?.subscription_id||'');return [...rows].sort((a,b)=>{const ap=String(a.id)===primaryId?0:1,bp=String(b.id)===primaryId?0:1;if(ap!==bp)return ap-bp;return new Date(b.created_at||0)-new Date(a.created_at||0);});}
function paymentIncidentForHold(hold,incidents){
    if(String(hold?.hold_type||'')!=='payment_risk')return null;
    const metadata=hold.metadata&&typeof hold.metadata==='object'?hold.metadata:{};
    const source=String(hold.source_key||'');
    const split=source.indexOf(':');
    const provider=String(metadata.provider||(split>0?source.slice(0,split):''));
    const caseId=String(metadata.caseId||(split>0?source.slice(split+1):''));
    return incidents.find(row=>String(row.provider||'')===provider&&String(row.provider_case_id||'')===caseId)||null;
}

async function customer360(customerId){
    const base=await query(`
        SELECT c.*,u.username AS login_username,u.email AS login_email,u.active AS login_active,
               u.created_at AS registered_at,u.updated_at AS login_updated_at,u.email_verified_at,u.last_login_at,
               u.password_changed_at,u.failed_login_count,u.locked_until,u.totp_enabled,u.id AS app_user_id
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
    `,[customerId]);
    if(!base.rowCount)return null;
    const customer=base.rows[0];
    const userId=customer.app_user_id;

    const [subscriptions,primaryEntitlement,holds,paymentIncidents,accounts,provisioningState,paymentCustomers,activeStreams,activitySummary,playback,policyEvents,downloadSummary,downloads,requests,runs,authSessions,authEvents,audit]=await Promise.all([
        query(`SELECT s.id,s.status,s.source,s.starts_at,CASE WHEN p.is_free_tier AND NOT ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%')) THEN NULL ELSE s.current_period_end END AS current_period_end,s.cancel_at_period_end,s.provider_customer_id,s.provider_subscription_id,s.created_at,s.updated_at,p.id plan_id,COALESCE(s.plan_code_snapshot,p.code) plan_code,COALESCE(s.plan_name_snapshot,p.name) plan_name,COALESCE(s.price_minor_snapshot,p.price_minor) price_minor,COALESCE(s.currency_snapshot,p.currency) currency,p.streams,p.allow_downloads,p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,p.server_class,p.library_access_mode,p.library_names,COALESCE(s.service_type_snapshot,p.service_type) service_type,p.is_addon,p.is_free_tier,COALESCE(s.billing_interval_snapshot,p.billing_interval) billing_interval,COALESCE(s.duration_days_snapshot,p.duration_days) duration_days FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 50`,[customerId]),
        provisioning.currentEntitlementTruth(customerId),
        accessHolds.activeHolds(customerId),
        query(`SELECT id,provider,provider_case_id,incident_type,incident_status,created_at FROM payment_incidents WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,[customerId]),
        query(`SELECT ja.id,ja.jellyfin_username,ja.disabled,ja.account_purpose,ja.is_primary,ja.created_at,ja.last_activity_at,ja.last_policy_sync,js.id server_id,js.name server_name,js.server_class,js.location,js.public_url,js.health_status,jpr.status recon_status,jpr.last_error recon_last_error,jpr.attempt_count recon_attempts,jpr.last_attempt_at recon_last_attempt FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id LEFT JOIN jellyfin_policy_reconciliation jpr ON jpr.jellyfin_account_id=ja.id WHERE ja.customer_id=$1 ORDER BY ja.created_at`,[customerId]),
        query(`SELECT status,attempt_count,consecutive_failures,last_error,last_attempt_at,last_success_at,next_attempt_at,subscription_id,plan_id,jellyfin_account_id,server_id,last_result,updated_at FROM customer_provisioning_state WHERE customer_id=$1 LIMIT 1`,[customerId]),
        query(`SELECT provider,provider_customer_id,created_at,updated_at FROM payment_customers WHERE customer_id=$1 ORDER BY provider`,[customerId]),
        query(`SELECT aps.item_name,aps.item_type,aps.client_name,aps.device_name,aps.playback_method,aps.is_paused,aps.first_seen_at,aps.last_seen_at,js.name server_name FROM active_playback_sessions aps LEFT JOIN jellyfin_servers js ON js.id=aps.server_id WHERE aps.customer_id=$1 ORDER BY aps.last_seen_at DESC`,[customerId]),
        query(`SELECT COUNT(*)::int sessions_30d,COUNT(*) FILTER(WHERE playback_method='transcode')::int transcodes_30d,COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at))),0)::bigint watch_seconds_30d,MAX(last_seen_at) last_playback_at FROM playback_history WHERE customer_id=$1 AND started_at>=NOW()-INTERVAL '30 days'`,[customerId]),
        query(`SELECT ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,ph.started_at,ph.last_seen_at,ph.ended_at,ph.ended_reason,js.name server_name FROM playback_history ph LEFT JOIN jellyfin_servers js ON js.id=ph.server_id WHERE ph.customer_id=$1 ORDER BY ph.started_at DESC LIMIT 100`,[customerId]),
        query(`SELECT decision,mode,stream_count,stream_limit,reason,created_at FROM stream_policy_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]),
        query(`SELECT COUNT(*)::int downloads_30d,COALESCE(SUM(bytes),0)::bigint bytes_30d,MAX(created_at) last_download_at FROM customer_download_events WHERE customer_id=$1 AND created_at>=NOW()-INTERVAL '30 days'`,[customerId]),
        query(`SELECT de.item_name,de.item_type,de.bytes,de.client_name,de.device_name,de.source,de.created_at,js.name server_name FROM customer_download_events de LEFT JOIN jellyfin_servers js ON js.id=de.server_id WHERE de.customer_id=$1 ORDER BY de.created_at DESC LIMIT 100`,[customerId]),
        query(`SELECT id,media_type,title,external_id,request_text,status,admin_response,created_at,resolved_at FROM content_requests WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]),
        query(`SELECT action,status,detail,started_at,completed_at FROM provisioning_runs WHERE customer_id=$1 ORDER BY started_at DESC LIMIT 100`,[customerId]),
        userId?query(`SELECT created_at,last_seen_at,expires_at,revoked_at,user_agent_hash FROM auth_sessions WHERE user_id=$1 ORDER BY last_seen_at DESC LIMIT 50`,[userId]):Promise.resolve({rows:[]}),
        userId?query(`SELECT event_type,success,identity_hint,user_agent_hash,created_at FROM auth_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[userId]):Promise.resolve({rows:[]}),
        query(`SELECT action,entity_type,entity_id,created_at FROM audit_log WHERE (entity_type='customer' AND entity_id::text=$1::text) OR (entity_type='subscription' AND entity_id::text IN (SELECT id::text FROM subscriptions WHERE customer_id=$1::uuid)) ORDER BY created_at DESC LIMIT 100`,[customerId])
    ]);

    const orderedSubscriptions=primaryFirst(subscriptions.rows,primaryEntitlement);
    const activeHolds=holds.map(hold=>{const incident=paymentIncidentForHold(hold,paymentIncidents.rows);return{...hold,payment_incident_id:incident?.id||null,payment_incident_type:incident?.incident_type||null,payment_incident_status:incident?.incident_status||null};});
    const timeline=buildTimeline([
        subscriptions.rows.map(x=>({at:x.created_at,type:'subscription',title:`${x.plan_name} · ${x.status}`,detail:x.source})),
        runs.rows.map(x=>({at:x.started_at,type:'provisioning',title:`${x.action} · ${x.status}`,detail:x.completed_at?'completed':'in progress'})),
        requests.rows.map(x=>({at:x.created_at,type:'request',title:`${x.title||x.request_text||'Media request'} · ${x.status}`,detail:x.media_type||''})),
        authEvents.rows.map(x=>({at:x.created_at,type:'security',title:x.event_type,detail:x.success?'Success':'Failed'})),
        audit.rows.map(x=>({at:x.created_at,type:'audit',title:x.action,detail:x.entity_type}))
    ]);

    return{
        customer,
        primaryEntitlement,
        activeHolds,
        subscriptions:orderedSubscriptions,
        accounts:accounts.rows,
        provisioningState:provisioningState.rows[0]||null,
        paymentCustomers:paymentCustomers.rows,
        activeStreams:activeStreams.rows,
        activitySummary:{...activitySummary.rows[0],watch_seconds_30d:seconds(activitySummary.rows[0]?.watch_seconds_30d)},
        playback:playback.rows,
        policyEvents:policyEvents.rows,
        downloadSummary:{...downloadSummary.rows[0],bytes_30d:bytes(downloadSummary.rows[0]?.bytes_30d)},
        downloads:downloads.rows,
        requests:requests.rows,
        runs:runs.rows,
        authSessions:authSessions.rows,
        authEvents:authEvents.rows,
        timeline
    };
}

// Computed separately (not inside customer360()) because it makes live
// Jellyfin discovery calls -- only the Access tab needs it, so other tabs
// (Overview/Activity/Billing/Security/History) stay fast and don't depend
// on Jellyfin server availability to render.
async function customerAccessDetail(customerId){
    const currentPlan=await provisioning.currentEntitlementTruth(customerId);
    const [effective,assignment]=await Promise.all([
        provisioning.effectivePolicyForCustomer(customerId,currentPlan),
        manualAssignment.candidates(customerId)
    ]);
    return{currentPlan,effective,assignment};
}

module.exports={customer360,customerAccessDetail,primaryFirst,paymentIncidentForHold};