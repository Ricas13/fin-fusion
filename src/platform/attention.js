'use strict';
const {query,transaction}=require('../db');
const workerHealth=require('../automation/worker-health');
function key(prefix,id){return `${prefix}:${id}`}
function item({key,title,area,severity='warning',detail='',href='',createdAt=null,sourceStatus='open'}){return{key,title,area,severity,detail,href,createdAt,sourceStatus}}
async function sourceItems(){const out=[];const[incidents,jobs,workers,servers,provisioning,notifications,backups,protectedActivations]=await Promise.all([
 query(`SELECT id,incident_type,incident_status,provider,provider_event_id,customer_id,reseller_id,created_at FROM payment_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`).catch(()=>({rows:[]})),
 query(`SELECT job_key,last_status,last_error,last_finished_at,enabled FROM automation_job_state WHERE enabled=TRUE AND (last_status='failed' OR (last_finished_at IS NOT NULL AND last_finished_at<NOW()-INTERVAL '2 days')) ORDER BY job_key`).catch(()=>({rows:[]})),
 query(`SELECT worker_key,last_heartbeat_at FROM operational_worker_state ORDER BY worker_key`).catch(()=>({rows:[]})),
 query(`SELECT id,name,health_status,last_health_check FROM jellyfin_servers WHERE enabled=TRUE AND health_status IN('offline','degraded') ORDER BY name`).catch(()=>({rows:[]})),
 query(`SELECT id,customer_id,action,status,detail,started_at FROM provisioning_runs WHERE status='failed' AND started_at>NOW()-INTERVAL '7 days' ORDER BY started_at DESC LIMIT 100`).catch(()=>({rows:[]})),
 query(`SELECT id,channel,event_type,message_type,status,last_error,created_at FROM notification_outbox WHERE status IN('failed','dead') ORDER BY created_at DESC LIMIT 100`).catch(()=>({rows:[]})),
 query(`SELECT id,status,error,started_at FROM backup_runs WHERE status='failed' OR (status='succeeded' AND verified_at IS NULL AND started_at<NOW()-INTERVAL '2 days') ORDER BY started_at DESC LIMIT 50`).catch(()=>({rows:[]})),
 query(`SELECT DISTINCT ON(c.id) c.id customer_id,COALESCE(c.display_name,u.username,u.email,'Customer') customer_name,u.email,t.created_at,EXTRACT(DAY FROM(NOW()-t.created_at))::int age_days,EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id) has_subscription,EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id) has_jellyfin,EXISTS(SELECT 1 FROM reseller_sales rs WHERE rs.customer_id=c.id) has_reseller_sale FROM account_activation_tokens t JOIN app_users u ON u.id=t.user_id JOIN customers c ON c.user_id=u.id LEFT JOIN platform_settings ps ON ps.setting_key='activation_cleanup_v1' WHERE t.purpose='customer_activation' AND t.used_at IS NULL AND t.revoked_at IS NULL AND u.role='customer' AND (EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id) OR EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id) OR EXISTS(SELECT 1 FROM reseller_sales rs WHERE rs.customer_id=c.id)) AND t.created_at<=NOW()-(COALESCE(NULLIF(ps.setting_value->>'retentionDays','')::int,30)||' days')::interval ORDER BY c.id,t.created_at DESC LIMIT 100`).catch(()=>({rows:[]}))
 ]);
 for(const r of incidents.rows)out.push(item({key:key('payment',r.id),title:`${r.provider||'Payment'} ${r.incident_type||'incident'}`,area:'Payments',severity:'critical',detail:`${r.incident_status||'open'} · ${r.provider_event_id||r.id}`,href:`/admin/commerce?incident=${encodeURIComponent(r.id)}#incident-${encodeURIComponent(r.id)}`,createdAt:r.created_at}));
 for(const r of jobs.rows)out.push(item({key:key('job',r.job_key),title:`Automation job: ${r.job_key}`,area:'Automation',severity:r.last_status==='failed'?'critical':'warning',detail:r.last_error||`Last completed ${r.last_finished_at||'never'}`,href:`/admin/automation?job=${encodeURIComponent(r.job_key)}#job-${encodeURIComponent(r.job_key)}`,createdAt:r.last_finished_at}));
 for(const r of workers.rows){const state=workerHealth.describe(r.worker_key,r.last_heartbeat_at);if(state.stale)out.push(item({key:key('worker',r.worker_key),title:`Worker heartbeat stale: ${r.worker_key}`,area:'Automation',severity:'critical',detail:`Heartbeat age ${state.ageSeconds}s · threshold ${state.thresholdSeconds}s`,href:`/admin/automation?worker=${encodeURIComponent(r.worker_key)}`,createdAt:r.last_heartbeat_at}))}
 for(const r of servers.rows)out.push(item({key:key('server',r.id),title:`${r.name} is ${r.health_status}`,area:'Servers',severity:r.health_status==='offline'?'critical':'warning',detail:`Last health check ${r.last_health_check||'never'}`,href:`/admin/servers/${r.id}/edit`,createdAt:r.last_health_check}));
 for(const r of provisioning.rows)out.push(item({key:key('provisioning',r.id),title:`Provisioning failed: ${r.action}`,area:'Customers',severity:'critical',detail:r.detail?.error||'Provisioning run failed',href:`/admin/users/${r.customer_id}?tab=access#provisioning-${encodeURIComponent(r.id)}`,createdAt:r.started_at}));
 for(const r of notifications.rows)out.push(item({key:key('notification',r.id),title:`${r.channel} notification ${r.status}`,area:'Notifications',severity:r.status==='dead'?'critical':'warning',detail:r.last_error||r.event_type||r.message_type||'',href:`${r.channel==='email'?'/admin/notifications':'/admin/notifications/preferences'}?outboxId=${encodeURIComponent(r.id)}#outbox-${encodeURIComponent(r.id)}`,createdAt:r.created_at}));
 for(const r of backups.rows)out.push(item({key:key('backup',r.id),title:r.status==='failed'?'Backup failed':'Backup has not been restore-verified',area:'Backups',severity:r.status==='failed'?'critical':'warning',detail:r.error||'Restore verification missing',href:`/admin/backups?run=${encodeURIComponent(r.id)}#backup-${encodeURIComponent(r.id)}`,createdAt:r.started_at}));
 for(const r of protectedActivations.rows)out.push(item({key:key('activation',r.customer_id),title:`Paid/provisioned account still not activated: ${r.customer_name}`,area:'Customers',severity:'warning',detail:`Activation pending ${r.age_days} day(s) · ${r.has_subscription?'subscription ':''}${r.has_jellyfin?'Jellyfin ':''}${r.has_reseller_sale?'reseller service':''}`.trim(),href:`/admin/users/${r.customer_id}?tab=access#activation`,createdAt:r.created_at}));
 return out}

async function workflowStates(keys){
 if(!keys.length)return[];
 try{return(await query(`SELECT fingerprint,acknowledged_at,assigned_to,note,updated_at FROM attention_workflow WHERE fingerprint=ANY($1::text[])`,[keys])).rows;}
 catch(error){
   // Acknowledgement/assignment state must never take the operational inbox down.
   // Migration 073 repairs legacy/partial schemas; this fallback keeps a rolling
   // deployment readable until that migration is applied.
   console.error('Attention workflow state unavailable:',error.message);
   return[];
 }
}

async function list(){
 const sources=await sourceItems(),keys=sources.map(i=>i.key),states=await workflowStates(keys);
 const by=new Map(states.map(s=>[s.fingerprint,s]));
 return sources.map(source=>{
   const stored=by.get(source.key)||{};
   return{...source,state:{status:stored.acknowledged_at!=null?'acknowledged':'open',assigned_to:stored.assigned_to||null,note:stored.note||null,updated_at:stored.updated_at||null}};
 }).sort((a,b)=>{const rank={critical:0,warning:1,info:2};return(rank[a.severity]??9)-(rank[b.severity]??9)||new Date(b.createdAt||0)-new Date(a.createdAt||0)});
}

async function openSummary(){
 const sources=await sourceItems();
 let updatedAt=null,latest=0;
 for(const source of sources){const ms=source.createdAt?new Date(source.createdAt).getTime():0;if(Number.isFinite(ms)&&ms>latest){latest=ms;updatedAt=source.createdAt}}
 return{count:sources.length,updatedAt};
}

async function setState(itemKey,{status='acknowledged',assignedTo=null,note=null},actorUserId=null){
 if(!['open','acknowledged'].includes(status))throw new Error('Attention items can only be open or acknowledged while the source issue remains active.');
 const source=(await sourceItems()).find(entry=>entry.key===String(itemKey));
 if(!source)throw new Error('This issue has already cleared from its source. Refresh Needs Attention.');
 const cleanNote=note==null?null:String(note).trim().slice(0,2000);
 const metadata=JSON.stringify({detail:source.detail||'',sourceStatus:source.sourceStatus||'open',sourceCreatedAt:source.createdAt||null});
 await transaction(async client=>{
   await client.query(`INSERT INTO attention_workflow(fingerprint,category,severity,title,href,first_seen_at,last_seen_at,cleared_at,metadata,updated_at) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),NOW(),NULL,$7::jsonb,NOW()) ON CONFLICT(fingerprint) DO UPDATE SET category=EXCLUDED.category,severity=EXCLUDED.severity,title=EXCLUDED.title,href=EXCLUDED.href,last_seen_at=NOW(),cleared_at=NULL,metadata=EXCLUDED.metadata,updated_at=NOW()`,[source.key,source.area,source.severity,source.title,source.href||null,source.createdAt||null,metadata]);
   await client.query(`UPDATE attention_workflow SET acknowledged_at=CASE WHEN $2='acknowledged' THEN COALESCE(acknowledged_at,NOW()) ELSE NULL END,acknowledged_by=CASE WHEN $2='acknowledged' THEN COALESCE(acknowledged_by,$3::uuid) ELSE NULL END,assigned_to=$4::uuid,note=$5,updated_at=NOW() WHERE fingerprint=$1`,[source.key,status,actorUserId||null,assignedTo||null,cleanNote]);
   await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.attention.update','attention_item',$2,$3::jsonb)`,[actorUserId,source.key,JSON.stringify({status,assignedTo:assignedTo||null,note:Boolean(cleanNote),sourceStillOpen:true})]);
 });
}
module.exports={list,setState,sourceItems,openSummary,workflowStates};
