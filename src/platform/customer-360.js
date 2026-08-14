'use strict';

const {query}=require('../db');
const provisioning=require('../jellyfin/provisioning');

function seconds(value){return Number(value||0)}
function bytes(value){return Number(value||0)}

function buildTimeline(parts){
    return parts.flat().filter(Boolean).sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,150);
}

async function customer360(customerId){
    const base=await query(`
        SELECT c.*,u.username AS login_username,u.email AS login_email,u.active AS login_active,
               u.created_at AS registered_at,u.updated_at AS login_updated_at,u.email_verified_at,u.last_login_at,
               u.password_changed_at,u.failed_login_count,u.locked_until,u.totp_enabled,u.id AS app_user_id,
               r.id AS reseller_id,ru.username AS reseller_username
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN resellers r ON r.id=c.reseller_id
        LEFT JOIN app_users ru ON ru.id=r.user_id
        WHERE c.id=$1
    `,[customerId]);
    if(!base.rowCount)return null;
    const customer=base.rows[0];
    const userId=customer.app_user_id;

    const [subscriptions,accounts,paymentCustomers,activeStreams,activitySummary,playback,policyEvents,downloadSummary,downloads,requests,runs,authSessions,authEvents,audit]=await Promise.all([
        query(`SELECT s.id,s.status,s.source,s.starts_at,s.current_period_end,s.cancel_at_period_end,s.provider_customer_id,s.provider_subscription_id,s.created_at,s.updated_at,p.code plan_code,p.name plan_name,p.price_minor,p.currency,p.streams,p.allow_downloads,p.allow_video_transcoding,p.allow_audio_transcoding,p.allow_live_tv,p.server_class,p.library_access_mode,p.library_names FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 50`,[customerId]),
        query(`SELECT ja.id,ja.jellyfin_username,ja.disabled,ja.created_at,ja.last_activity_at,ja.last_policy_sync,js.id server_id,js.name server_name,js.server_class,js.location,js.public_url,js.health_status,jpr.status recon_status,jpr.last_error recon_last_error,jpr.attempt_count recon_attempts,jpr.last_attempt_at recon_last_attempt FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id LEFT JOIN jellyfin_policy_reconciliation jpr ON jpr.jellyfin_account_id=ja.id WHERE ja.customer_id=$1 ORDER BY ja.created_at`,[customerId]),
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
        query(`SELECT action,entity_type,entity_id,created_at FROM audit_log WHERE (entity_type='customer' AND entity_id=$1::text) OR (entity_type='subscription' AND entity_id IN (SELECT id::text FROM subscriptions WHERE customer_id=$1)) ORDER BY created_at DESC LIMIT 100`,[customerId])
    ]);

    const timeline=buildTimeline([
        subscriptions.rows.map(x=>({at:x.created_at,type:'subscription',title:`${x.plan_name} · ${x.status}`,detail:x.source})),
        runs.rows.map(x=>({at:x.started_at,type:'provisioning',title:`${x.action} · ${x.status}`,detail:x.completed_at?'completed':'in progress'})),
        requests.rows.map(x=>({at:x.created_at,type:'request',title:`${x.title||x.request_text||'Media request'} · ${x.status}`,detail:x.media_type||''})),
        authEvents.rows.map(x=>({at:x.created_at,type:'security',title:x.event_type,detail:x.success?'Success':'Failed'})),
        audit.rows.map(x=>({at:x.created_at,type:'audit',title:x.action,detail:x.entity_type}))
    ]);

    return{
        customer,
        subscriptions:subscriptions.rows,
        accounts:accounts.rows,
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
    const currentPlan=await provisioning.currentEntitlement(customerId);
    const effective=await provisioning.effectivePolicyForCustomer(customerId,currentPlan);
    return{currentPlan,effective};
}

async function reseller360(resellerId){
    const base=await query(`
        SELECT r.id,r.user_id,r.credits,r.trial_credits,r.note,r.created_at,
               u.username,u.email,u.active,u.last_login_at,u.password_changed_at,u.failed_login_count,u.locked_until,u.totp_enabled,u.created_at registered_at
        FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1
    `,[resellerId]);
    if(!base.rowCount)return null;
    const reseller=base.rows[0];

    const [customers,credits,activeStreams,activitySummary,playback,downloadSummary,downloads,requests,authSessions,authEvents,audit,planMix]=await Promise.all([
        query(`SELECT c.id,c.display_name,c.email,c.discord_username,c.created_at,u.username login_username,u.active login_active,cur.status subscription_status,cur.current_period_end,cur.plan_name,COALESCE(acc.account_count,0)::int jellyfin_accounts,acc.last_activity_at,COALESCE(ast.active_streams,0)::int active_streams FROM customers c LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN LATERAL(SELECT s.status,s.current_period_end,p.name plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=c.id ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1) cur ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) account_count,MAX(last_activity_at) last_activity_at FROM jellyfin_accounts WHERE customer_id=c.id) acc ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) active_streams FROM active_playback_sessions WHERE customer_id=c.id) ast ON TRUE WHERE c.reseller_id=$1 ORDER BY COALESCE(acc.last_activity_at,c.created_at) DESC NULLS LAST`,[resellerId]),
        query(`SELECT amount,transaction_type,note,created_at FROM credit_transactions WHERE reseller_id=$1 ORDER BY created_at DESC LIMIT 150`,[resellerId]),
        query(`SELECT aps.customer_id,aps.item_name,aps.item_type,aps.client_name,aps.device_name,aps.playback_method,aps.is_paused,aps.first_seen_at,aps.last_seen_at,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,js.name server_name FROM active_playback_sessions aps JOIN customers c ON c.id=aps.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN jellyfin_servers js ON js.id=aps.server_id WHERE c.reseller_id=$1 ORDER BY aps.last_seen_at DESC`,[resellerId]),
        query(`SELECT COUNT(*)::int sessions_30d,COUNT(DISTINCT ph.customer_id)::int active_customers_30d,COUNT(*) FILTER(WHERE ph.playback_method='transcode')::int transcodes_30d,COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))),0)::bigint watch_seconds_30d,MAX(ph.last_seen_at) last_playback_at FROM playback_history ph JOIN customers c ON c.id=ph.customer_id WHERE c.reseller_id=$1 AND ph.started_at>=NOW()-INTERVAL '30 days'`,[resellerId]),
        query(`SELECT ph.customer_id,ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,ph.started_at,ph.ended_at,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,js.name server_name FROM playback_history ph JOIN customers c ON c.id=ph.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN jellyfin_servers js ON js.id=ph.server_id WHERE c.reseller_id=$1 ORDER BY ph.started_at DESC LIMIT 150`,[resellerId]),
        query(`SELECT COUNT(*)::int downloads_30d,COALESCE(SUM(de.bytes),0)::bigint bytes_30d,COUNT(DISTINCT de.customer_id)::int downloading_customers_30d,MAX(de.created_at) last_download_at FROM customer_download_events de JOIN customers c ON c.id=de.customer_id WHERE c.reseller_id=$1 AND de.created_at>=NOW()-INTERVAL '30 days'`,[resellerId]),
        query(`SELECT de.customer_id,de.item_name,de.item_type,de.bytes,de.client_name,de.device_name,de.source,de.created_at,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,js.name server_name FROM customer_download_events de JOIN customers c ON c.id=de.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN jellyfin_servers js ON js.id=de.server_id WHERE c.reseller_id=$1 ORDER BY de.created_at DESC LIMIT 150`,[resellerId]),
        query(`SELECT cr.id,cr.customer_id,cr.media_type,cr.title,cr.request_text,cr.status,cr.created_at,cr.resolved_at,COALESCE(c.display_name,u.username,c.email,'Reseller') customer_name FROM content_requests cr LEFT JOIN customers c ON c.id=cr.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE cr.reseller_id=$1 OR c.reseller_id=$1 ORDER BY cr.created_at DESC LIMIT 150`,[resellerId]),
        query(`SELECT created_at,last_seen_at,expires_at,revoked_at,user_agent_hash FROM auth_sessions WHERE user_id=$1 ORDER BY last_seen_at DESC LIMIT 50`,[reseller.user_id]),
        query(`SELECT event_type,success,identity_hint,user_agent_hash,created_at FROM auth_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[reseller.user_id]),
        query(`SELECT action,entity_type,entity_id,created_at FROM audit_log WHERE (entity_type='reseller' AND entity_id=$1::text) OR actor_user_id=$2 ORDER BY created_at DESC LIMIT 150`,[resellerId,reseller.user_id]),
        query(`SELECT p.name,COUNT(*)::int subscriptions FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN customers c ON c.id=s.customer_id WHERE c.reseller_id=$1 AND s.status IN ('active','trialing','past_due') AND s.current_period_end>NOW() GROUP BY p.id ORDER BY subscriptions DESC,p.name`,[resellerId])
    ]);

    const timeline=buildTimeline([
        credits.rows.map(x=>({at:x.created_at,type:'credits',title:`${x.transaction_type} ${x.amount>0?'+':''}${x.amount}`,detail:x.note||''})),
        requests.rows.map(x=>({at:x.created_at,type:'request',title:`${x.title||x.request_text||'Media request'} · ${x.status}`,detail:x.customer_name||''})),
        authEvents.rows.map(x=>({at:x.created_at,type:'security',title:x.event_type,detail:x.success?'Success':'Failed'})),
        audit.rows.map(x=>({at:x.created_at,type:'audit',title:x.action,detail:x.entity_type}))
    ]);

    return{
        reseller,
        customers:customers.rows,
        credits:credits.rows,
        activeStreams:activeStreams.rows,
        activitySummary:{...activitySummary.rows[0],watch_seconds_30d:seconds(activitySummary.rows[0]?.watch_seconds_30d)},
        playback:playback.rows,
        downloadSummary:{...downloadSummary.rows[0],bytes_30d:bytes(downloadSummary.rows[0]?.bytes_30d)},
        downloads:downloads.rows,
        requests:requests.rows,
        authSessions:authSessions.rows,
        authEvents:authEvents.rows,
        planMix:planMix.rows,
        timeline
    };
}

module.exports={customer360,reseller360,customerAccessDetail};
