'use strict';

const {query,transaction}=require('../db');
const jobHealth=require('../automation/job-health');
const policy=require('./actionable-attention-policy');

const BACKUP_CRITICAL_STALE_MS=48*60*60*1000;

function key(prefix,id){return `${prefix}:${id}`}
function item({key,title,area,severity='warning',detail='',href='',createdAt=null,sourceStatus='open',actionLabel=null}){return{key,title,area,severity,detail,href,createdAt,sourceStatus,actionLabel}}
function humanize(value){return String(value||'issue').replace(/[_-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}
function ageLabel(ms){
 const seconds=Math.max(0,Math.round(Number(ms||0)/1000));
 if(seconds<120)return`${seconds}s`;
 const minutes=Math.round(seconds/60);if(minutes<120)return`${minutes} min`;
 const hours=Math.round(minutes/60);if(hours<48)return`${hours} hr`;
 return`${Math.round(hours/24)} days`;
}
function provisioningProblemText(row){
 const value=row?.last_error||row?.run_detail?.error||row?.run_detail?.message||'';
 return String(value||'Customer access reconciliation failed.').trim().slice(0,1000);
}
function workerLabel(workerKey){
 if(workerKey==='automation')return'Automation worker';
 if(workerKey==='activity')return'Playback activity worker';
 return`${humanize(workerKey)} worker`;
}

async function sourceItems(){
 const out=[];
 const now=Date.now();
 const[incidents,jobs,workers,servers,provisioning,notifications,backups,stremioSources]=await Promise.all([
  query(`SELECT id,incident_type,incident_status,provider,provider_event_id,provider_case_id,customer_id,scope,access_action,created_at FROM payment_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`).catch(()=>({rows:[]})),
  jobHealth.list().then(rows=>({rows})).catch(()=>({rows:[]})),
  query(`SELECT worker_key,last_heartbeat_at,draining_at,metadata FROM operational_worker_state ORDER BY worker_key`).catch(()=>({rows:[]})),
  query(`SELECT id,name,health_status,last_health_check FROM jellyfin_servers WHERE enabled=TRUE AND health_status IN('offline','degraded') ORDER BY name`).catch(()=>({rows:[]})),
  query(`SELECT cps.customer_id,cps.status,cps.consecutive_failures,cps.last_error,cps.last_attempt_at,cps.last_success_at,cps.next_attempt_at,cps.updated_at,
      COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') customer_name,
      lr.id run_id,lr.action last_action,lr.detail run_detail,lr.started_at run_started_at,
      (SELECT MIN(pr2.started_at) FROM provisioning_runs pr2 WHERE pr2.customer_id=cps.customer_id AND pr2.status='failed' AND pr2.started_at>COALESCE(cps.last_success_at,'1970-01-01'::timestamptz)) problem_started_at
    FROM customer_provisioning_state cps
    JOIN customers c ON c.id=cps.customer_id
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN LATERAL(SELECT id,action,detail,started_at FROM provisioning_runs pr WHERE pr.customer_id=cps.customer_id ORDER BY started_at DESC LIMIT 1)lr ON TRUE
    WHERE cps.status IN('failed','blocked')
    ORDER BY COALESCE(cps.last_attempt_at,cps.updated_at) DESC LIMIT 100`).catch(()=>({rows:[]})),
  query(`SELECT channel,
      COUNT(*) FILTER(WHERE status='dead')::int dead_count,
      COUNT(*) FILTER(WHERE channel='email' AND status='failed' AND attempts>=5 AND created_at<NOW()-INTERVAL '6 hours')::int persistent_count,
      MIN(created_at) FILTER(WHERE status='dead' OR (channel='email' AND status='failed' AND attempts>=5 AND created_at<NOW()-INTERVAL '6 hours')) oldest_at
    FROM notification_outbox
    WHERE status='dead' OR (channel='email' AND status='failed' AND attempts>=5 AND created_at<NOW()-INTERVAL '6 hours')
    GROUP BY channel ORDER BY channel`).catch(()=>({rows:[]})),
  query(`WITH latest_success AS(
      SELECT id,status,error,verification_note,verified_at,started_at FROM backup_runs WHERE status='succeeded' ORDER BY started_at DESC LIMIT 1
    ),latest_failure AS(
      SELECT id,status,error,NULL::text verification_note,NULL::timestamptz verified_at,started_at FROM backup_runs WHERE status='failed' ORDER BY started_at DESC LIMIT 1
    )
    SELECT f.id,f.status,f.error,f.verification_note,f.verified_at,f.started_at,s.started_at last_success_at
      FROM latest_failure f LEFT JOIN latest_success s ON TRUE
      WHERE s.started_at IS NULL OR s.started_at<=f.started_at
    UNION ALL
    SELECT s.id,s.status,s.error,s.verification_note,s.verified_at,s.started_at,s.started_at last_success_at
      FROM latest_success s
      WHERE s.verified_at IS NULL AND s.started_at<NOW()-INTERVAL '2 days'
        AND NOT EXISTS(SELECT 1 FROM latest_failure f WHERE f.started_at>s.started_at)
    ORDER BY started_at DESC`).catch(()=>({rows:[]})),
  query(`SELECT id,name,auth_state,last_error,updated_at FROM stremio_sources WHERE enabled=TRUE AND auth_state='reconnect_required' ORDER BY updated_at DESC LIMIT 100`).catch(()=>({rows:[]}))
 ]);

 // Payment events are not all incidents requiring human intervention. Refunds
 // and mapped failed renewals remain history/provider lifecycle unless identity
 // or checkout reconciliation is unresolved; disputes/chargebacks stay urgent.
 for(const row of incidents.rows){
   const decision=policy.paymentDecision(row);if(!decision.visible)continue;
   const type=humanize(row.incident_type),provider=humanize(row.provider||'Payment');
   out.push(item({key:key('payment',row.id),title:`${provider} ${type} needs review`,area:'Payments',severity:decision.severity,detail:row.scope==='unresolved'?`CAPTAiNFiN could not safely match this ${String(row.incident_type||'payment event').replace(/_/g,' ')} to a customer.`:`${humanize(row.incident_status||'open')} · ${row.provider_case_id||row.provider_event_id||row.id}`,href:`/admin/commerce?incident=${encodeURIComponent(row.id)}#incident-${encodeURIComponent(row.id)}`,createdAt:row.created_at,actionLabel:'Review payment case'}));
 }

 const workerByKey=new Map(workers.rows.map(row=>[String(row.worker_key),row]));
 const workerDecisions=new Map();
 for(const expected of ['automation','activity']){
   const row=workerByKey.get(expected)||null,decision=policy.workerDecision(row,now,process.uptime());
   workerDecisions.set(expected,decision);
   if(!decision.visible)continue;
   const label=workerLabel(expected),detail=row?`No heartbeat for ${ageLabel(decision.ageMs)}. Automatic work may be paused.`:`${label} has not checked in since this application process started.`;
   out.push(item({key:key('worker',expected),title:`${label} is not responding`,area:'Automation',severity:decision.severity,detail,href:`/admin/automation?worker=${encodeURIComponent(expected)}`,createdAt:row?.last_heartbeat_at||null,actionLabel:'Open automation'}));
 }
 for(const row of workers.rows){
   const workerKey=String(row.worker_key||'');if(workerDecisions.has(workerKey))continue;
   const decision=policy.workerDecision(row,now,process.uptime());if(!decision.visible)continue;
   out.push(item({key:key('worker',workerKey),title:`${workerLabel(workerKey)} is not responding`,area:'Automation',severity:decision.severity,detail:`No heartbeat for ${ageLabel(decision.ageMs)}.`,href:`/admin/automation?worker=${encodeURIComponent(workerKey)}`,createdAt:row.last_heartbeat_at,actionLabel:'Open automation'}));
 }

 const automationUnavailable=Boolean(workerDecisions.get('automation')?.visible);
 const healthJob=jobs.rows.find(row=>row.job_key==='health')||null;
 if(!automationUnavailable){
   for(const row of jobs.rows){
     const state=jobHealth.healthState(row),decision=policy.jobDecision(row,state);if(!decision.visible)continue;
     // When server health itself is the downstream failure, show the affected
     // server(s) below rather than a duplicate generic health-job warning.
     if(row.job_key==='health'&&servers.rows.some(server=>server.health_status==='offline'))continue;
     const retry=row.next_run_at?` Automatic retry is scheduled for ${new Date(row.next_run_at).toLocaleString('en-GB')}.`:'';
     const diagnostic=row.last_error||row.last_warning||`Last successful run ${row.last_success_at||'has not been recorded'}.`;
     const streak=decision.failures?` ${decision.failures} consecutive unhealthy runs.`:'';
     out.push(item({key:key('job',row.job_key),title:`Automation keeps failing: ${humanize(row.job_key)}`,area:'Automation',severity:decision.severity,detail:`${diagnostic}${streak}${retry}`.slice(0,1200),href:`/admin/automation?job=${encodeURIComponent(row.job_key)}#job-${encodeURIComponent(row.job_key)}`,createdAt:row.last_completed_at||row.last_started_at||row.last_success_at,actionLabel:'Open automation'}));
   }

   const serverFindings=servers.rows.map(row=>({row,decision:policy.serverDecision(row,healthJob)})).filter(entry=>entry.decision.visible);
   if(serverFindings.length===1){
     const{row,decision}=serverFindings[0],streak=decision.failures?`${decision.failures} consecutive fleet-health runs have failed. `:'';
     out.push(item({key:key('server',row.id),title:`${row.name} remains unreachable`,area:'Servers',severity:decision.severity,detail:`${streak}Last health check ${row.last_health_check||'unknown'}.`,href:`/admin/servers/dashboard?server=${encodeURIComponent(row.id)}`,createdAt:row.last_health_check,actionLabel:'Open server recovery'}));
   }else if(serverFindings.length>1){
     const severity=serverFindings.some(entry=>entry.decision.severity==='critical')?'critical':'warning';
     const names=serverFindings.slice(0,4).map(entry=>entry.row.name).join(', '),more=serverFindings.length>4?` +${serverFindings.length-4} more`:'';
     out.push(item({key:key('server','fleet'),title:`${serverFindings.length} Jellyfin servers remain unreachable`,area:'Servers',severity,detail:`Repeated health checks are still failing for ${names}${more}.`,href:'/admin/servers/dashboard',createdAt:serverFindings.map(entry=>entry.row.last_health_check).filter(Boolean).sort().at(-1)||null,actionLabel:'Open fleet recovery'}));
   }
 }

 // customer_provisioning_state is the current authority. Historical run rows
 // remain troubleshooting history and cannot keep a recovered customer red.
 for(const row of provisioning.rows){
   const decision=policy.provisioningDecision(row,now);if(!decision.visible)continue;
   const next=row.next_attempt_at?` Next automatic retry ${new Date(row.next_attempt_at).toLocaleString('en-GB')}.`:'';
   const streak=decision.failures?` ${decision.failures} consecutive failed attempts.`:'';
   const removal=String(row.last_action||'').toLowerCase()==='disable';
   out.push(item({key:key('provisioning',row.customer_id),title:removal?`Access removal failed for ${row.customer_name}`:`Customer access still cannot reconcile: ${row.customer_name}`,area:'Customers',severity:decision.severity,detail:`${provisioningProblemText(row)}${streak}${next}`.slice(0,1400),href:`/admin/provisioning?customer=${encodeURIComponent(row.customer_id)}`,createdAt:row.problem_started_at||row.last_attempt_at||row.updated_at,actionLabel:removal?'Review access removal':'Review access retry'}));
 }

 // Failed notification attempts remain in automatic retry and are diagnostics,
 // not individual operator tasks. Only exhausted non-email delivery or email
 // that has kept failing for hours becomes one aggregate warning per channel.
 for(const row of notifications.rows){
   const channel=String(row.channel||'email').toLowerCase(),dead=Number(row.dead_count||0),persistent=Number(row.persistent_count||0);
   if(dead>0)out.push(item({key:key('notification',`${channel}:dead`),title:`${humanize(channel)} delivery exhausted automatic retries`,area:'Notifications',severity:'warning',detail:`${dead} notification${dead===1?'':'s'} reached the retry limit. Review the channel and retry only if the destination is still valid.`,href:channel==='email'?'/admin/notifications':'/admin/notifications/preferences',createdAt:row.oldest_at,actionLabel:'Open delivery failures'}));
   else if(persistent>0)out.push(item({key:key('notification',`${channel}:persistent`),title:`${persistent} email${persistent===1?' is':'s are'} still failing after retries`,area:'Notifications',severity:'warning',detail:'CAPTAiNFiN has already retried these messages for at least six hours. Check SMTP health before manually retrying them.',href:'/admin/notifications',createdAt:row.oldest_at,actionLabel:'Open email delivery'}));
 }

 for(const row of backups.rows){
   if(row.status==='failed'){
     const lastSuccess=policy.timestamp(row.last_success_at),age=lastSuccess?Math.max(0,now-lastSuccess):Infinity;
     const severity=!lastSuccess||age>=BACKUP_CRITICAL_STALE_MS?'critical':'warning';
     const context=lastSuccess?` Last successful recovery point is ${ageLabel(age)} old.`:' No successful recovery point is recorded.';
     out.push(item({key:key('backup',row.id),title:'Latest backup attempt failed',area:'Backups',severity,detail:`${row.error||'Backup creation failed.'}${context}`,href:`/admin/backups?run=${encodeURIComponent(row.id)}#backup-${encodeURIComponent(row.id)}`,createdAt:row.started_at,actionLabel:'Open backup recovery'}));
   }else{
     out.push(item({key:key('backup',row.id),title:'Latest backup is still unverified',area:'Backups',severity:'warning',detail:row.verification_note||'The newest recovery point has remained unverified for more than two days.',href:`/admin/backups?run=${encodeURIComponent(row.id)}#backup-${encodeURIComponent(row.id)}`,createdAt:row.started_at,actionLabel:'Verify recovery point'}));
   }
 }

 // Authentication failures need a person to reconnect credentials. Generic
 // Stremio index/source errors already have scheduled retry and are surfaced by
 // automation only if they persist across repeated runs.
 for(const row of stremioSources.rows)out.push(item({key:key('stremio-source',row.id),title:`Stremio source must be reconnected: ${row.name}`,area:'Servers',severity:'critical',detail:row.last_error||'Stored source credentials are no longer accepted. Automatic retry cannot repair credentials.',href:`/admin/servers/stremio/${row.id}`,createdAt:row.updated_at,actionLabel:'Reconnect source'}));

 return out;
}

async function workflowStates(keys){
 if(!keys.length)return[];
 try{return(await query(`SELECT fingerprint,acknowledged_at,assigned_to,note,updated_at FROM attention_workflow WHERE fingerprint=ANY($1::text[])`,[keys])).rows;}
 catch(error){console.error('Attention workflow state unavailable:',error.message);return[];}
}

async function list(options={}){
 const sources=await sourceItems(),keys=sources.map(entry=>entry.key),states=await workflowStates(keys),by=new Map(states.map(state=>[state.fingerprint,state]));
 const items=sources.map(source=>{const stored=by.get(source.key)||{};return{...source,state:{status:stored.acknowledged_at!=null?'acknowledged':'open',assigned_to:stored.assigned_to||null,note:stored.note||null,updated_at:stored.updated_at||null}};});
 return items.filter(entry=>options.includeAcknowledged||entry.state.status!=='acknowledged').sort((a,b)=>{const rank={critical:0,warning:1,info:2};return(rank[a.severity]??9)-(rank[b.severity]??9)||new Date(b.createdAt||0)-new Date(a.createdAt||0)});
}

async function openSummary(){
 const sources=await list();let updatedAt=null,latest=0;
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

module.exports={list,setState,sourceItems,openSummary,workflowStates,provisioningProblemText,ageLabel};
