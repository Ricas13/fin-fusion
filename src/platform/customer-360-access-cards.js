'use strict';

const policy=require('../jellyfin/policy');
const {esc}=require('./admin-html');

const FIELD_LABELS={
  streams:'Concurrent streams',
  allow_downloads:'Downloads',
  allow_video_transcoding:'Video transcode',
  allow_audio_transcoding:'Audio transcode',
  allow_remuxing:'Remuxing',
  allow_live_tv:'Live TV',
  allow_live_tv_management:'Live TV recording',
  allow_remote_access:'Remote access',
  allow_subtitle_editing:'Subtitle editing'
};

function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function fmtDate(value){if(!value)return'—';if(value===Infinity||String(value).toLowerCase()==='infinity')return'Never';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function isRecurring(sub){const ref=String(sub?.provider_subscription_id||'');return (sub?.source==='stripe'&&/^sub_/i.test(ref))||(sub?.source==='paypal'&&/^I-/i.test(ref));}
function isPermanent(plan){return plan?.access_expires_at===Infinity||String(plan?.access_expires_at||'').toLowerCase()==='infinity';}
function booleanLabel(value){return value?'Allowed':'Blocked';}
function enabledLabel(value){return value?'Enabled':'Disabled';}
function pill(value,tone=''){return `<span class="pill ${tone}">${esc(value)}</span>`;}
function td(label,value){return `<td data-label="${esc(label)}">${value==null||value===''?'—':value}</td>`;}
function tr(cells){return `<tr>${cells.join('')}</tr>`;}
function table(headers,rows){if(!rows.length)return'<div class="emptyCompact">No records yet.</div>';return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr>${headers.map(header=>`<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
function bulkPreviewForm(token,customerId,action,label,tone='secondary'){return `<form class="plainForm" method="post" action="/admin/customers/bulk/preview" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="customerId" value="${esc(customerId)}"><input type="hidden" name="action" value="${esc(action)}"><button class="button ${esc(tone)}" type="submit">${esc(label)}</button></form>`;}
function reconcileForm(token,customerId,label='Reconcile access',tone='secondary'){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/reconcile" data-native-submit="true">${csrfHidden(token)}<button class="button ${esc(tone)}" type="submit">${esc(label)}</button></form>`;}
function permanentForm(token,customerId,active){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/permanent-access" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="action" value="${active?'revoke':'enable'}"><input type="hidden" name="reason" value="${esc(active?'Permanent access removed from Customer 360 Access':'Permanent access granted from Customer 360 Access')}"><button class="button secondary" type="submit">${active?'Reset expiry to subscription':'Make permanent'}</button></form>`;}
function reenableForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/jellyfin/re-enable" data-native-submit="true">${csrfHidden(token)}<button class="button primary" type="submit">Re-enable Jellyfin access</button></form>`;}
function planPlacementForm(token,customerId){return `<details class="compactAction"><summary class="button secondary">Use plan placement…</summary><form class="formPanel compactAction" method="post" action="/admin/users/${encodeURIComponent(customerId)}/server-placement/reset" data-native-submit="true">${csrfHidden(token)}<div class="inlineHelp">Re-evaluates automatic plan placement. If a different server is selected, CAPTAiNFiN uses the guarded move workflow.</div><div class="formGroup"><label>Type <strong>PLACE</strong> to confirm</label><input class="input" name="confirmation" autocomplete="off" placeholder="PLACE" required></div><button class="button secondary" type="submit">Apply plan placement</button></form></details>`;}
function expiryResetForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/expiry/reset" data-native-submit="true">${csrfHidden(token)}<button class="button secondary" type="submit">Reset expiry to plan term</button></form>`;}
function planTerm(plan){if(!plan)return'—';if(plan.is_free_tier)return'Free Access · no normal expiry';const interval=String(plan.billing_interval_snapshot||plan.billing_interval||'').replaceAll('_',' ');if(interval)return interval;const days=Number(plan.duration_days_snapshot||plan.duration_days||0);return days?`${days} days`:'Plan-controlled';}

function assignmentCapacityLabel(server){
  const users=Number(server?.assigned_users||0),max=Number(server?.max_users||0);
  if(!max)return `${users} user${users===1?'':'s'} · no configured limit`;
  if(users>max)return `${users}/${max} · OVER +${users-max}`;
  if(users===max)return `${users}/${max} · FULL`;
  return `${users}/${max} · ${Math.max(0,max-users)} left`;
}

function manualAssignmentForm(token,customerId,assignment){
  if(!assignment?.entitlement||(assignment.activeAccounts||[]).length)return'';
  const servers=assignment.servers||[];
  if(!servers.length)return `<div class="operatorCallout warn"><strong>No eligible Jellyfin server is available for manual assignment.</strong> Capacity is not the blocker here. Check server enablement, health, plan eligibility and required libraries.</div>`;
  const options=servers.map(server=>`<option value="${esc(server.id)}">${esc(server.name)} · ${esc(server.health_status||'unknown')} · ${esc(assignmentCapacityLabel(server))}</option>`).join('');
  return `<section class="accessAssignCard"><div class="accessAssignHead"><div><strong>Assign Jellyfin server</strong><span>Admin placement ignores the configured user ceiling.</span></div>${pill('Unlimited admin override','warn')}</div><div class="operatorCallout warn"><strong>You can deliberately exceed capacity by any amount.</strong> A 50-user limit still blocks public signup and automatic placement at 50, but you can manually place this customer at 51/50, 100/50 or 1000/50 without changing the limit or reopening Free Server availability.</div><form class="accessAssignForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/assign-server" data-native-submit="true">${csrfHidden(token)}<select class="input" name="serverId" required><option value="">Choose server…</option>${options}</select><button class="button primary" type="submit">Assign Jellyfin server</button></form></section>`;
}

function overviewCard(label,value,sub,actions=''){return `<article class="accessOverviewCard"><span class="accessEyebrow">${esc(label)}</span><strong class="accessOverviewValue">${esc(value)}</strong><span class="accessOverviewSub">${esc(sub)}</span>${actions?`<div class="accessCardActions">${actions}</div>`:''}</article>`;}

function accessOverview(detail,token,accessDetail){
  const customerId=detail.customer.id,plan=accessDetail?.currentPlan||detail.primaryEntitlement||activeSubscription(detail),sub=activeSubscription(detail),accounts=(detail.accounts||[]).filter(a=>String(a.account_purpose||'jellyfin')!=='stremio_internal'),active=accounts.filter(a=>!a.disabled),disabled=accounts.filter(a=>a.disabled),permanent=isPermanent(plan),freePlan=Boolean(plan?.is_free_tier||sub?.is_free_tier);
  const planName=plan?.name||plan?.plan_name||plan?.plan_name_snapshot||sub?.plan_name||sub?.plan_code||'No active plan';
  const planSub=[plan?.service_type_snapshot||plan?.service_type||sub?.service_type||'jellyfin',plan?.server_class||sub?.server_class||'automatic placement'].join(' · ');
  const serverValue=active.length?active.map(a=>a.server_name||'Assigned server').join(', '):disabled.length?`${disabled[0].server_name||'Assigned server'} · disabled`:'Not assigned';
  const serverSub=active.length?(active[0].jellyfin_username||'Jellyfin account active'):(disabled.length?'Existing account can be restored':'Choose automatic placement or assign manually');
  const provisioning=detail.provisioningState||{};
  const pStatus=String(provisioning.status||'').toLowerCase();
  const failed=['failed','blocked'].includes(pStatus);
  const provisionValue=failed?'Needs attention':active.length?'Active':pStatus||'Not provisioned';
  const provisionSub=failed?(provisioning.last_error||'Provisioning failed'):active.length?'Jellyfin access is available':'No active Jellyfin account';
  const expiryValue=permanent?'Never':fmtDate(sub?.current_period_end||plan?.current_period_end);
  const expirySub=permanent?'Permanent customer override':isRecurring(sub)?'Provider billing period':planTerm(plan);
  const planActions=bulkPreviewForm(token,customerId,'plan_change','Change entitlement','secondary');
  const serverActions=active.length?`${bulkPreviewForm(token,customerId,'migrate_server','Move server','secondary')}${reconcileForm(token,customerId,'Reconcile','secondary')}${planPlacementForm(token,customerId)}`:disabled.length&&freePlan?`${reenableForm(token,customerId)}${reconcileForm(token,customerId,'Reconcile','secondary')}`:reconcileForm(token,customerId,'Try automatic provisioning','secondary');
  const provisionActions=reconcileForm(token,customerId,failed?'Retry provisioning':'Reconcile','secondary');
  let expiryActions='';
  if(permanent)expiryActions=permanentForm(token,customerId,true);
  else if(isRecurring(sub))expiryActions=`<a class="button secondary" href="/admin/users/${encodeURIComponent(customerId)}?tab=billing">Manage renewal</a>${permanentForm(token,customerId,false)}`;
  else expiryActions=`${bulkPreviewForm(token,customerId,'set_expiry','Change expiry','secondary')}${expiryResetForm(token,customerId)}${permanentForm(token,customerId,false)}`;
  const lastError=String(provisioning.last_error||'Jellyfin access could not be created.').trim().replace(/[.!?]+$/,'');
  const warning=failed?`<div class="notice error"><strong>Provisioning failed / Needs attention.</strong> ${esc(lastError)}. ${freePlan?'This Free Server entitlement remains allocated while you repair or manually assign access.':'The entitlement remains active while you repair access.'}</div>`:'';
  return `<section class="accessOverviewSection"><div class="sectionHead"><div><h2>Access overview</h2><div class="muted">The controls you normally need are kept above policy and history.</div></div>${pill(failed?'Needs attention':'Access controls',failed?'warn':'good')}</div>${warning}<div class="accessOverviewGrid">${overviewCard('Plan',planName,planSub,planActions)}${overviewCard('Jellyfin server',serverValue,serverSub,serverActions)}${overviewCard('Provisioning',provisionValue,provisionSub,provisionActions)}${overviewCard('Expiry',expiryValue,expirySub,expiryActions)}</div>${manualAssignmentForm(token,customerId,accessDetail?.assignment)}</section>`;
}

function technicalChoice(field,row){
  const label=FIELD_LABELS[field]||field,hasOverride=row?.override!==null&&row?.override!==undefined;
  // Plan/Effective only differ from each other when there's an override, so
  // showing that breakdown -- and the redundant Inherited/Override pill --
  // for the common all-defaults case just repeats the value already shown.
  const meta=hasOverride?`<div class="accessControlMeta">${field==='streams'?`<span>Plan <strong>${esc(row?.plan??'—')}</strong></span>`:`<span>Plan <strong>${esc(booleanLabel(Boolean(row?.plan)))}</strong></span>`}</div>`:'';
  const overridePill=hasOverride?pill('Override','accent'):'';
  if(field==='streams'){
    return `<article class="accessControlCard"><div class="accessControlHead"><div><span class="accessEyebrow">${esc(label)}</span><strong>${esc(row?.effective??'—')}</strong></div>${overridePill}</div>${meta}<label class="accessNumberControl"><span>Override</span><input class="input compact" type="number" name="${esc(field)}" min="1" max="50" placeholder="Inherit" value="${hasOverride?esc(row.override):''}"></label></article>`;
  }
  const option=(value,text,checked)=>`<label class="accessChoice"><input type="radio" name="${esc(field)}" value="${esc(value)}" ${checked?'checked':''}><span>${esc(text)}</span></label>`;
  return `<article class="accessControlCard"><div class="accessControlHead"><div><span class="accessEyebrow">${esc(label)}</span><strong>${esc(booleanLabel(Boolean(row?.effective)))}</strong></div>${overridePill}</div>${meta}<div class="accessChoices">${option('','Inherit',!hasOverride)}${option('true','Allow',hasOverride&&row.override===true)}${option('false','Deny',hasOverride&&row.override===false)}</div></article>`;
}

function technicalControls(detail,token,accessDetail){
  const eff=accessDetail?.effective;if(!eff)return'';
  const customerId=detail.customer.id;
  const cards=policy.TECHNICAL_FIELDS.map(field=>technicalChoice(field,eff.technicalRows[field]||{})).join('');
  const overrides=policy.TECHNICAL_FIELDS.filter(field=>eff.technicalRows[field]?.override!==null&&eff.technicalRows[field]?.override!==undefined).length;
  const total=policy.TECHNICAL_FIELDS.length;
  return `<details class="section accessDisclosure accessControlsSection"${overrides?' open':''}><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Access controls</span><strong>${overrides?`${overrides} override${overrides===1?'':'s'}`:`${total}/${total} following plan`}</strong><span>Plan defaults stay intact unless you explicitly override a customer.</span></div><span class="button secondary">Manage access controls</span></summary><div class="accessDisclosureBody"><form method="post" action="/admin/users/${encodeURIComponent(customerId)}/policy-overrides">${csrfHidden(token)}<div class="accessControlGrid">${cards}</div><div class="accessSaveRow"><button class="button primary" type="submit">Save access changes</button><span class="muted">Inherit removes the customer override and follows the plan again.</span></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/policy-overrides/reset-all">${csrfHidden(token)}<button class="button secondary" type="submit">Reset access controls to plan</button></form></div></details>`;
}

function libraryChoice(row,index){
  const hasOverride=row.override!==null&&row.override!==undefined;
  const meta=hasOverride?`<div class="accessControlMeta"><span>Plan <strong>${esc(enabledLabel(Boolean(row.plan)))}</strong></span></div>`:'';
  const overridePill=hasOverride?pill('Override','accent'):'';
  const option=(value,text,checked)=>`<label class="accessChoice"><input type="radio" name="libraryValue_${index}" value="${esc(value)}" ${checked?'checked':''}><span>${esc(text)}</span></label>`;
  return `<article class="accessControlCard"><input type="hidden" name="libraryName" value="${esc(row.name)}"><div class="accessControlHead"><div><span class="accessEyebrow">${esc(row.name)}</span><strong>${esc(enabledLabel(Boolean(row.effective)))}</strong></div>${overridePill}</div>${meta}<div class="accessChoices">${option('','Inherit',!hasOverride)}${option('true','Allow',hasOverride&&row.override===true)}${option('false','Deny',hasOverride&&row.override===false)}</div></article>`;
}
function librariesSection(detail,token,accessDetail){
  const eff=accessDetail?.effective;if(!eff)return'';
  const customerId=detail.customer.id,rows=eff.entitlementRows||[],overrides=rows.filter(row=>row.override!==null&&row.override!==undefined).length,effective=rows.filter(row=>row.effective).length;
  const failed=(eff.catalog?.failedServers||[]).length?`<div class="notice error">Could not read libraries from: ${esc(eff.catalog.failedServers.join(', '))}. Those servers were not changed.</div>`:'';
  const content=rows.length?`<form method="post" action="/admin/users/${encodeURIComponent(customerId)}/library-overrides">${csrfHidden(token)}<div class="accessControlGrid">${rows.map((row,index)=>libraryChoice(row,index)).join('')}</div><div class="accessSaveRow"><button class="button primary" type="submit">Save library changes</button><span class="muted">Changes apply only to this customer.</span></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/library-overrides/reset-all">${csrfHidden(token)}<button class="button secondary" type="submit">Reset libraries to plan</button></form>`:'<div class="emptyCompact">No libraries discovered on eligible servers yet.</div>';
  return `<details class="section accessDisclosure accessControlsSection"${overrides?' open':''}><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Libraries</span><strong>${effective} enabled</strong><span>${rows.length} available · ${overrides} customer override${overrides===1?'':'s'}</span></div><span class="button secondary">Manage libraries</span></summary><div class="accessDisclosureBody">${failed}${content}</div></details>`;
}

function householdSection(detail,token,accessDetail,options){
  const plan=accessDetail?.currentPlan;if(!plan)return'';
  const rows=[];
  if(plan.jellyfin_access_model==='household_network')rows.push(['jellyfin','Jellyfin household networks',plan.jellyfin_household_network_limit,options.householdOverrides?.jellyfin?.network_limit??null]);
  const service=String(plan.service_type_snapshot||plan.service_type||'jellyfin').toLowerCase();
  if(service==='stremio'||service==='bundle')rows.push(['stremio','Stremio household networks',plan.stremio_household_network_limit,options.householdOverrides?.stremio?.network_limit??null]);
  if(!rows.length)return'';
  const body=rows.map(([name,label,planValue,override])=>`<label class="accessHouseholdCard"><span class="accessEyebrow">${esc(label)}</span><strong>${esc(override??planValue??'—')}</strong><span>Plan ${esc(planValue??'—')} · ${override==null?'Inherited':'Customer override'}</span><input class="input compact" type="number" name="${esc(name)}" min="1" max="10" placeholder="Inherit" value="${override==null?'':esc(override)}"></label>`).join('');
  return `<details class="section accessDisclosure"><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Household limits</span><strong>${rows.length} network rule${rows.length===1?'':'s'}</strong><span>Collapsed unless you need to override the plan.</span></div><span class="button secondary">Manage limits</span></summary><div class="accessDisclosureBody"><form method="post" action="/admin/users/${encodeURIComponent(detail.customer.id)}/household-overrides">${csrfHidden(token)}<div class="accessHouseholdGrid">${body}</div><div class="accessSaveRow"><button class="button primary" type="submit">Save household limits</button></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(detail.customer.id)}/household-overrides/reset-all">${csrfHidden(token)}<button class="button secondary" type="submit">Reset household limits to plan</button></form></div></details>`;
}

function accountDetails(detail){
  const accounts=(detail.accounts||[]).filter(a=>String(a.account_purpose||'jellyfin')!=='stremio_internal');
  if(!accounts.length)return'';
  const rows=accounts.map(account=>tr([td('Username',`<strong>${esc(account.jellyfin_username)}</strong>`),td('Server',esc(account.server_name||'—')),td('Health',pill(account.health_status||'unknown',account.health_status==='healthy'?'good':account.health_status==='offline'?'bad':'warn')),td('Status',pill(account.disabled?'Disabled':'Enabled',account.disabled?'bad':'good')),td('Reconcile',pill(account.recon_status||'Not run',account.recon_status==='successful'?'good':account.recon_status==='failed'?'bad':'warn')),td('Last activity',esc(fmtDate(account.last_activity_at))) ]));
  return `<details class="section accessDisclosure"><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Jellyfin account details</span><strong>${accounts.length} account${accounts.length===1?'':'s'}</strong><span>Server health, reconciliation and last activity.</span></div><span class="button secondary">View details</span></summary><div class="accessDisclosureBody">${table(['Username','Server','Health','Status','Reconcile','Last activity'],rows)}${accounts.some(a=>!a.disabled)?`<div class="buttonRow"><a class="button secondary" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(detail.customer.id)}">Change Jellyfin password</a></div>`:''}</div></details>`;
}

function provisioningHistory(detail){
  const runs=(detail.runs||[]).slice(0,50),failed=runs.filter(run=>run.status==='failed').length;
  const rows=runs.map(run=>tr([td('Started',esc(fmtDate(run.started_at))),td('Action',esc(run.action)),td('Status',pill(run.status,run.status==='succeeded'?'good':run.status==='failed'?'bad':'warn')),td('Completed',esc(fmtDate(run.completed_at)))]));
  return `<details class="section accessDisclosure accessHistory"><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Provisioning history</span><strong>${runs.length} event${runs.length===1?'':'s'}</strong><span>${failed?`${failed} failed`:'No failures in the visible history'}</span></div><span class="button secondary">View history</span></summary><div class="accessDisclosureBody">${table(['Started','Action','Status','Completed'],rows)}</div></details>`;
}

function activitySection(detail){
  const active=detail.activeStreams||[],history=(detail.playback||[]).slice(0,30),sessions=Number(detail.activitySummary?.sessions_30d||0),last=detail.activitySummary?.last_playback_at;
  const activeRows=active.map(item=>tr([td('Now',`<strong>${esc(item.item_name||'Unknown')}</strong>`),td('Client',esc(item.client_name||'—')),td('Method',pill(item.playback_method||'—',item.playback_method==='transcode'?'warn':'good')),td('Server',esc(item.server_name||'—')),td('Last seen',esc(fmtDate(item.last_seen_at)))]));
  const historyRows=history.map(item=>tr([td('Started',esc(fmtDate(item.started_at))),td('Item',`<strong>${esc(item.item_name||'Unknown')}</strong>`),td('Client',esc(item.client_name||'—')),td('Method',pill(item.playback_method||'—',item.playback_method==='transcode'?'warn':'good')),td('Server',esc(item.server_name||'—'))]));
  const body=`${active.length?`<h3>Playing now</h3>${table(['Item','Client','Method','Server','Last seen'],activeRows)}`:''}<h3>Recent playback</h3>${table(['Started','Item','Client','Method','Server'],historyRows)}<div class="buttonRow"><a class="button secondary" href="/admin/users/${encodeURIComponent(detail.customer.id)}?tab=activity">Open full Activity tab</a></div>`;
  return `<details class="section accessDisclosure accessActivity"><summary class="accessDisclosureSummary"><div><span class="accessEyebrow">Activity</span><strong>${active.length?`${active.length} active now`:sessions?`${sessions} sessions / 30d`:'No recent playback'}</strong><span>${last?`Last playback ${fmtDate(last)}`:'Playback details stay out of the way until needed.'}</span></div><span class="button secondary">View activity</span></summary><div class="accessDisclosureBody">${body}</div></details>`;
}

function styles(){return `<style>
.accessOverviewSection{margin:0 0 16px}.accessOverviewGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:12px 0}.accessOverviewCard,.accessControlCard,.accessAssignCard,.accessHouseholdCard{border:1px solid var(--border,#29333d);background:rgba(255,255,255,.018);border-radius:10px;padding:14px;min-width:0}.accessOverviewCard{display:flex;flex-direction:column;gap:7px}.accessEyebrow{display:block;font-size:.72rem;letter-spacing:.055em;text-transform:uppercase;color:var(--muted,#9aa7b5);font-weight:700}.accessOverviewValue{font-size:1.06rem;line-height:1.25}.accessOverviewSub{color:var(--muted,#9aa7b5);font-size:.82rem;line-height:1.35;overflow-wrap:anywhere}.accessCardActions{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto;padding-top:6px}.accessCardActions .button{padding:7px 9px;font-size:.78rem}.accessAssignCard{margin:12px 0}.accessAssignHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}.accessAssignHead div{display:grid;gap:3px}.accessAssignHead span:not(.pill){color:var(--muted,#9aa7b5);font-size:.82rem}.accessAssignForm{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:10px}.accessControlGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0}.accessControlCard{display:grid;gap:12px}.accessControlHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.accessControlHead>div{display:grid;gap:4px}.accessControlHead strong{font-size:1.02rem}.accessControlMeta{display:flex;justify-content:space-between;gap:8px;color:var(--muted,#9aa7b5);font-size:.78rem}.accessControlMeta strong{color:inherit}.accessChoices{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.accessChoice{position:relative}.accessChoice input{position:absolute;opacity:0;pointer-events:none}.accessChoice span{display:block;text-align:center;border:1px solid var(--border,#29333d);border-radius:7px;padding:7px 5px;font-size:.78rem;cursor:pointer}.accessChoice input:checked+span{border-color:#2ca9bc;background:rgba(44,169,188,.13);color:#d9fbff;font-weight:700}.accessChoice input:focus-visible+span{outline:2px solid #65d8e8;outline-offset:2px}.accessNumberControl{display:grid;grid-template-columns:auto minmax(80px,1fr);align-items:center;gap:10px;color:var(--muted,#9aa7b5);font-size:.8rem}.accessSaveRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}.accessDisclosure{overflow:hidden}.accessDisclosure>summary{list-style:none;cursor:pointer}.accessDisclosure>summary::-webkit-details-marker{display:none}.accessDisclosureSummary{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 14px}.accessDisclosureSummary>div{display:grid;gap:3px}.accessDisclosureSummary strong{font-size:1rem}.accessDisclosureSummary>div>span:last-child{color:var(--muted,#9aa7b5);font-size:.8rem}.accessDisclosureBody{border-top:1px solid var(--border,#29333d);padding:14px}.accessLibraryGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.accessLibraryRow{display:grid;grid-template-columns:minmax(0,1fr) 130px;align-items:center;gap:10px;border:1px solid var(--border,#29333d);border-radius:8px;padding:10px}.accessLibraryRow>div{display:grid;gap:3px;min-width:0}.accessLibraryRow span{font-size:.76rem;color:var(--muted,#9aa7b5)}.accessHouseholdGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.accessHouseholdCard{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center}.accessHouseholdCard .accessEyebrow,.accessHouseholdCard>span{grid-column:1}.accessHouseholdCard input{grid-column:2;grid-row:1/4;max-width:110px}.accessActivity{margin-bottom:22px}.accessDisclosure h3{margin:4px 0 10px;font-size:.95rem}.accessDisclosure h3:not(:first-child){margin-top:18px}
@media(max-width:1250px){.accessOverviewGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.accessControlGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.accessOverviewGrid,.accessControlGrid,.accessLibraryGrid,.accessHouseholdGrid{grid-template-columns:1fr}.accessAssignForm{grid-template-columns:1fr}.accessDisclosureSummary{align-items:flex-start}.accessDisclosureSummary>.button{white-space:nowrap}.accessLibraryRow{grid-template-columns:1fr}.accessHouseholdCard{grid-template-columns:1fr}.accessHouseholdCard input{grid-column:1;grid-row:auto;max-width:none}}
</style>`;}

function render(detail,token,accessDetail,options={}){
  if(!detail?.customer?.id)return'';
  return `${styles()}${accessOverview(detail,token,accessDetail)}${technicalControls(detail,token,accessDetail)}${librariesSection(detail,token,accessDetail)}${householdSection(detail,token,accessDetail,options)}${accountDetails(detail)}${provisioningHistory(detail)}${activitySection(detail)}`;
}

module.exports={render,accessOverview,technicalControls,librariesSection,householdSection,accountDetails,provisioningHistory,activitySection,manualAssignmentForm,assignmentCapacityLabel,styles};
