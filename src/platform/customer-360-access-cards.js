'use strict';

const policy=require('../jellyfin/policy');
const {esc}=require('./admin-html');
const provisioning=require('../jellyfin/resilient-provisioning');
const laneOverrides=require('../jellyfin/lane-policy-overrides');
const requestOverrides=require('../integrations/request-permission-overrides');
const requestPolicy=require('../integrations/request-plan-policy');
const {laneEntitlements}=require('./admin-lane-policy');
const manage=require('./admin-customer-management');
const stremioEntitlementsSvc=require('../stremio/entitlements');
const billing=require('./admin-customer-billing');
const moneyFormat=require('./money-format');

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
const LANE_LABEL={primary:'Premium',free:'Free Server'};

function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function fmtDate(value){if(!value)return'—';if(value===Infinity||String(value).toLowerCase()==='infinity')return'Never';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function isRecurring(sub){const ref=String(sub?.provider_subscription_id||'');return (sub?.source==='stripe'&&/^sub_/i.test(ref))||(sub?.source==='paypal'&&/^I-/i.test(ref));}
function booleanLabel(value){return value?'Allowed':'Blocked';}
function enabledLabel(value){return value?'Enabled':'Disabled';}
function pill(value,tone=''){return `<span class="pill ${tone}">${esc(value)}</span>`;}
function td(label,value){return `<td data-label="${esc(label)}">${value==null||value===''?'—':value}</td>`;}
function tr(cells){return `<tr>${cells.join('')}</tr>`;}
function table(headers,rows){if(!rows.length)return'<div class="emptyCompact">No records yet.</div>';return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr>${headers.map(header=>`<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
function bulkPreviewForm(token,customerId,action,label,tone='secondary'){return `<form class="plainForm" method="post" action="/admin/customers/bulk/preview">${csrfHidden(token)}<input type="hidden" name="customerId" value="${esc(customerId)}"><input type="hidden" name="action" value="${esc(action)}"><button class="button ${esc(tone)}" type="submit">${esc(label)}</button></form>`;}
function reconcileForm(token,customerId,label='Reconcile access',tone='secondary'){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/reconcile" data-native-submit="true">${csrfHidden(token)}<button class="button ${esc(tone)}" type="submit">${esc(label)}</button></form>`;}
function permanentForm(token,customerId,active){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/permanent-access" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="action" value="${active?'revoke':'enable'}"><input type="hidden" name="reason" value="${esc(active?'Permanent access removed from Customer control':'Permanent access granted from Customer control')}"><button class="button secondary" type="submit">${active?'Reset expiry to subscription':'Make permanent'}</button></form>`;}
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

/* ==================================================================
   1. CUSTOMER CONTROL — 3x3 grid. Everything an administrator can
   change for this customer, always visible, no menus to open first.
   Consolidates the old operator console (Jellyfin assign/move/remove,
   server-rendered here now instead of client-injected), the old
   "Access status" holds summary, and the old "Access overview"
   plan/expiry cards into one grid. ================================== */

function ctlCard(num,label,value,sub,actions,extra=''){
  return `<article class="ctlCard"><span class="ctlNum">${num}</span><div class="ctlTop"><div><span class="ctlLabel">${esc(label)}</span><strong>${esc(value)}</strong></div>${extra}</div>${sub?`<div class="ctlSub">${esc(sub)}</div>`:''}${actions?`<div class="ctlActions">${actions}</div>`:''}</article>`;
}

function jellyfinAccountCard(num,token,customerId,ctx){
  const active=ctx.activeAccounts||[];
  if(!ctx.entitlement)return ctlCard(num,'Jellyfin account','Not required',ctx.serviceKind==='stremio'?'Stremio-only plan':'No Jellyfin plan','');
  if(!active.length){
    // A disabled account (usually Free Server inactivity-disabled) is a
    // different state from never having had one -- re-enable the existing
    // account rather than offering to assign a brand-new one elsewhere.
    const disabled=(ctx.accounts||[]).find(a=>a.disabled);
    if(disabled){
      const reenableForm=`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/jellyfin/re-enable" data-native-submit="true">${csrfHidden(token)}<button class="button sm primary" type="submit">Re-enable Jellyfin access</button></form>`;
      return ctlCard(num,'Jellyfin account',disabled.jellyfin_username,`${disabled.server_name} · disabled`,reenableForm,pill('Disabled','warn'));
    }
    const servers=(ctx.servers||[]).filter(s=>s.operable&&s.server_class===ctx.entitlement.serverClass);
    const options=servers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${esc(assignmentCapacityLabel(s))}</option>`).join('');
    const assignForm=servers.length?`<form class="ctlInlineForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/operator/assign">${csrfHidden(token)}<select class="input compact" name="serverId" required><option value="">Choose a server…</option>${options}</select><button class="button sm primary" type="submit">Add to server</button></form>`:'<div class="ctlNote">No eligible server available.</div>';
    return ctlCard(num,'Jellyfin account','Needs access','Plan active, no enabled account yet',assignForm,pill('Needs access','bad'));
  }
  const account=active[0];
  return ctlCard(num,'Jellyfin account',account.jellyfin_username,`${account.server_name}${active.length>1?` +${active.length-1} more`:''}`,
    `<a class="button sm" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}">Change password</a>`,
    pill('Healthy','good'));
}

function serverCard(num,token,customerId,ctx){
  if(!ctx.entitlement)return ctlCard(num,'Server','—','No Jellyfin plan','');
  const active=ctx.activeAccounts||[];
  if(!active.length)return ctlCard(num,'Server','Not assigned','Waiting on Jellyfin account','');
  const servers=(ctx.servers||[]).filter(s=>s.operable&&s.server_class===ctx.entitlement.serverClass&&s.id!==active[0].server_id);
  const options=servers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${esc(assignmentCapacityLabel(s))}</option>`).join('');
  const moveForm=servers.length?`<form class="ctlInlineForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/operator/move">${csrfHidden(token)}<select class="input compact" name="serverId" required><option value="">Move to…</option>${options}</select><button class="button sm" type="submit">Move</button></form>`:'';
  return ctlCard(num,'Server',active[0].server_name,ctx.adminControl?.mode==='forced_server'?'Admin-selected server':'Automatic placement',moveForm);
}

function managementCard(num,token,customerId,ctx){
  if(!ctx.entitlement)return ctlCard(num,'Management','Automatic','No Jellyfin plan to control','');
  const mode=ctx.adminControl?.mode;
  const value=mode==='removed'?'Removed by admin':mode==='forced_server'?'Admin-selected server':'Automatic rules';
  let actions='';
  if(mode==='removed')actions=`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/operator/automatic">${csrfHidden(token)}<button class="button sm primary" type="submit">Return to automatic</button></form>`;
  else if((ctx.activeAccounts||[]).length)actions=`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/operator/remove">${csrfHidden(token)}<input type="hidden" name="reason" value="Removed from Jellyfin by administrator"><button class="button sm" type="submit">Remove Jellyfin access</button></form>`;
  return ctlCard(num,'Management',value,mode==='removed'?'Background automation will not re-add this customer':'',actions);
}

function planCard(num,token,customerId,plan,permanent){
  const value=permanent?.active?(permanent.plan_name||plan?.plan_name||'Permanent plan'):(plan?(plan.plan_name||plan.contract_plan_name||plan.plan_code||'Active plan'):'No active plan');
  return ctlCard(num,'Plan',value,permanent?.active?'Permanent access':'',bulkPreviewForm(token,customerId,'plan_change','Manual entitlement edit','secondary'));
}

function expiryCard(num,token,customerId,plan,sub,permanent){
  const value=permanent?.active?'Never':(sub&&sub.current_period_end?fmtDate(sub.current_period_end):'—');
  let actions='';
  if(permanent?.active)actions=permanentForm(token,customerId,true);
  else if(isRecurring(sub))actions=`<a class="button sm" href="/admin/users/${encodeURIComponent(customerId)}?tab=billing">Manage renewal</a>`;
  else actions=`${bulkPreviewForm(token,customerId,'set_expiry','Change expiry','secondary')}`;
  return ctlCard(num,'Expiry',value,permanent?.active?'Permanent customer override':(isRecurring(sub)?'Provider billing period':planTerm(plan)),actions);
}

function holdsCard(num,token,customerId,detail){
  const holds=Array.isArray(detail.activeHolds)?detail.activeHolds:[];
  return ctlCard(num,'Access holds',holds.length?`${holds.length} active`:'None active',holds.length?'See Access status below':'No active access holds',holds.length?'':reconcileForm(token,customerId,'Reconcile access','secondary'),holds.length?pill('Restricted','warn'):pill('Clear','good'));
}

function reconcileCard(num,token,customerId,detail){
  const state=detail.provisioningState||{};
  const failed=['failed','blocked'].includes(String(state.status||''));
  return ctlCard(num,'Reconcile',failed?'Needs attention':(state.last_success_at?'Last: succeeded':'Not yet run'),state.last_success_at?fmtDate(state.last_success_at):(state.last_error||''),reconcileForm(token,customerId,failed?'Retry now':'Reconcile now','secondary'),failed?pill('Failed','bad'):'');
}

function portalCard(num,token,customerId,detail){
  const c=detail.customer;
  const impersonate=c.app_user_id?`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/impersonate">${csrfHidden(token)}<button class="button sm" type="submit">View portal</button></form>`:'';
  return ctlCard(num,'Portal',c.app_user_id?(c.login_active===false?'Disabled':'Active'):'No portal account',c.login_username||'',impersonate);
}

function moreCard(num,token,customerId,ctx,permanent,sub){
  const links=[];
  if(ctx.entitlement){
    links.push(planPlacementForm(token,customerId));
    if((ctx.activeAccounts||[]).length)links.push(bulkPreviewForm(token,customerId,'migrate_server','Move server (guided)','secondary'));
    links.push(bulkPreviewForm(token,customerId,'suspend','Suspend service access','secondary'));
    links.push(bulkPreviewForm(token,customerId,'end_jellyfin_plan','Cancel / end current plan','secondary'));
  }
  if(!permanent?.active&&sub&&!isRecurring(sub))links.push(expiryResetForm(token,customerId));
  if(!permanent?.active)links.push(permanentForm(token,customerId,false));
  if((ctx.accounts||[]).length)links.push(bulkPreviewForm(token,customerId,'jellyfin_delete','Delete Jellyfin account(s)','secondary'));
  links.push(bulkPreviewForm(token,customerId,'portal_delete','Delete customer…','danger'));
  return `<article class="ctlCard ctlMore"><span class="ctlNum">${num}</span><div class="ctlTop"><div><span class="ctlLabel">More</span><strong>Rarely used</strong></div></div><div class="ctlMoreList">${links.join('')||'<span class="ctlNote">Nothing else to do here.</span>'}</div></article>`;
}

function controlGrid(detail,token,ctx,permanent){
  const customerId=detail.customer.id,plan=ctx?.entitlement?{plan_name:ctx.entitlement.planName,contract_plan_name:ctx.entitlement.planName,is_free_tier:ctx.entitlement.isFreeTier,server_class:ctx.entitlement.serverClass}:null;
  const sub=activeSubscription(detail);
  const safeCtx=ctx||{entitlement:null,accounts:[],activeAccounts:[],servers:[],adminControl:null,serviceKind:'none'};
  const cards=[
    planCard(1,token,customerId,plan||sub,permanent),
    jellyfinAccountCard(2,token,customerId,safeCtx),
    serverCard(3,token,customerId,safeCtx),
    managementCard(4,token,customerId,safeCtx),
    holdsCard(5,token,customerId,detail),
    expiryCard(6,token,customerId,plan||sub,sub,permanent),
    reconcileCard(7,token,customerId,detail),
    portalCard(8,token,customerId,detail),
    moreCard(9,token,customerId,safeCtx,permanent,sub)
  ];
  return `<section class="section"><div class="sectionHead"><div><h2>Customer control</h2><div class="muted">Everything an administrator can change for this customer, always visible.</div></div></div><div class="ctlGrid">${cards.join('')}</div></section>`;
}

/* ==================================================================
   2. ACCESS STATUS — holds detail/release workflow. Compact when
   there are no holds (the common case); expands with real
   release-confirmation UX when there are. ================================== */

function accessStatusSection(detail,token){
  const accessStatus=require('./customer-360-access-status');
  return accessStatus.render(detail,token);
}

/* ==================================================================
   3. ACCESS, LIBRARIES & REQUESTS — one 2-column panel per access
   lane the customer holds (Free Server / Premium), each with three
   independently collapsible dense-row panels (Access controls,
   Jellyseerr requests, Libraries), plus a Stremio panel for
   stremio-only/bundle customers. ================================== */

function segmented(name,checkedValue){
  const option=(value,text)=>`<label class="segChoice"><input type="radio" name="${esc(name)}" value="${esc(value)}" ${checkedValue===value?'checked':''}><span>${esc(text)}</span></label>`;
  return `<div class="segmented">${option('','Inherit')}${option('true','Allow')}${option('false','Deny')}</div>`;
}

function technicalRow(field,row){
  const label=FIELD_LABELS[field]||field,hasOverride=row?.override!==null&&row?.override!==undefined;
  if(field==='streams'){
    return `<div class="denseRow"><span class="lbl">${esc(label)}</span><span class="val">${esc(row?.effective??'—')}</span><input class="streamInput" type="number" name="${esc(field)}" min="1" max="50" placeholder="Inherit" value="${hasOverride?esc(row.override):''}"></div>`;
  }
  return `<div class="denseRow"><span class="lbl">${esc(label)}</span><span class="val">${esc(booleanLabel(Boolean(row?.effective)))}</span>${segmented(field,hasOverride?String(row.override):'')}</div>`;
}

function accessControlsPanel(lane,token,customerId,technicalRows){
  const overrides=policy.TECHNICAL_FIELDS.filter(field=>technicalRows[field]?.override!==null&&technicalRows[field]?.override!==undefined).length;
  const rows=policy.TECHNICAL_FIELDS.map(field=>technicalRow(field,technicalRows[field]||{})).join('');
  return `<details class="panel"${overrides?' open':''}><summary><span>Access controls</span><span class="chev">▸</span><span class="cnt">${overrides?`${overrides} override${overrides===1?'':'s'}`:`${policy.TECHNICAL_FIELDS.length}/${policy.TECHNICAL_FIELDS.length} following plan`}</span></summary><div class="panelBody"><form method="post" action="/admin/users/${encodeURIComponent(customerId)}/lane-policy-overrides">${csrfHidden(token)}<input type="hidden" name="accessLane" value="${esc(lane)}"><div class="denseList">${rows}</div><div class="denseSaveRow"><button class="button primary sm" type="submit">Save</button></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/lane-policy-overrides/reset-all">${csrfHidden(token)}<input type="hidden" name="accessLane" value="${esc(lane)}"><button class="button secondary sm" type="submit">Reset to plan</button></form></div></details>`;
}

function requestRow(item){
  const hasOverride=item.override!==null&&item.override!==undefined;
  return `<div class="denseRow"><span class="lbl">${esc(item.label)}</span><span class="val">${esc(item.plan?'Plan allows':'Plan blocks')}</span>${segmented(`permission_${item.key}`,hasOverride?String(item.override):'')}</div>`;
}

function requestsPanel(token,customerId,effective){
  const groups=new Map();
  for(const row of effective.rows){if(!groups.has(row.group))groups.set(row.group,[]);groups.get(row.group).push(row);}
  const overrides=effective.rows.filter(row=>row.override!==null&&row.override!==undefined).length;
  const body=[...groups.entries()].map(([group,rows])=>`<div class="groupHead"><span>${esc(group)}</span></div>${rows.map(requestRow).join('')}`).join('');
  return `<details class="panel"${overrides?' open':''}><summary><span>Jellyseerr requests</span><span class="chev">▸</span><span class="cnt">${overrides?`${overrides} override${overrides===1?'':'s'}`:'Plan default'}</span></summary><div class="panelBody"><form method="post" action="/admin/users/${encodeURIComponent(customerId)}/request-permission-overrides">${csrfHidden(token)}<div class="denseList">${body}</div><div class="denseSaveRow"><button class="button primary sm" type="submit">Save</button></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/request-permission-overrides/reset-all">${csrfHidden(token)}<button class="button secondary sm" type="submit">Reset to plan</button></form></div></details>`;
}

function libraryRow(row,lane,index){
  const hasOverride=row.override!==null&&row.override!==undefined;
  return `<div class="denseRow"><input type="hidden" name="libraryName" value="${esc(row.name)}"><span class="lbl">${esc(row.name)}</span><span class="val">${esc(enabledLabel(Boolean(row.effective)))}</span>${segmented(`libraryValue_${lane}_${index}`,hasOverride?String(row.override):'')}</div>`;
}

function libraryBucket(name){
  if(/tv/i.test(name))return'TV';
  if(/movie/i.test(name))return'Movies';
  return'Discovery';
}

function librariesPanel(lane,token,customerId,entitlementRows,failedServers){
  const overrides=entitlementRows.filter(row=>row.override!==null&&row.override!==undefined).length;
  const effective=entitlementRows.filter(row=>row.effective).length;
  const groups={Movies:[],TV:[],Discovery:[]};
  entitlementRows.forEach((row,index)=>groups[libraryBucket(row.name)].push([row,index]));
  const body=['Movies','TV','Discovery'].filter(group=>groups[group].length).map(group=>`<div class="groupHead"><span>${esc(group)}</span><b>${groups[group].filter(([row])=>row.effective).length}/${groups[group].length} enabled</b></div>${groups[group].map(([row,index])=>libraryRow(row,lane,index)).join('')}`).join('');
  const failed=failedServers.length?`<div class="notice error">Could not read libraries from: ${esc(failedServers.join(', '))}.</div>`:'';
  const content=entitlementRows.length?`<form method="post" action="/admin/users/${encodeURIComponent(customerId)}/library-overrides">${csrfHidden(token)}<input type="hidden" name="accessLane" value="${esc(lane)}"><div class="denseList">${body}</div><div class="denseSaveRow"><button class="button primary sm" type="submit">Save</button></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/library-overrides/reset-all">${csrfHidden(token)}<input type="hidden" name="accessLane" value="${esc(lane)}"><button class="button secondary sm" type="submit">Reset to plan</button></form>`:'<div class="emptyCompact">No libraries discovered on eligible servers yet.</div>';
  return `<details class="panel"${overrides?' open':''}><summary><span>Libraries</span><span class="chev">▸</span><span class="cnt">${effective}/${entitlementRows.length} enabled${overrides?` · ${overrides} override${overrides===1?'':'s'}`:''}</span></summary><div class="panelBody">${failed}${content}</div></details>`;
}

async function laneEffective(customerId,lane,planRow){
  const [technical,libOverrides,requestEffective]=await Promise.all([
    laneOverrides.effectiveTechnical(customerId,lane,planRow),
    provisioning.getLibraryOverrides(customerId,lane),
    requestOverrides.effectivePermissions(customerId,planRow?.request_permissions)
  ]);
  const catalog=await provisioning.libraryCatalogForServerClass(planRow.server_class);
  const entitlementRows=policy.libraryEntitlement(planRow,libOverrides,catalog.names);
  return{technicalRows:technical.technicalRows,entitlementRows,failedServers:catalog.failedServers,requestEffective};
}

function householdPanel(token,customerId,rows){
  if(!rows.length)return'';
  const body=rows.map(([name,label,planValue,override])=>`<div class="denseRow"><span class="lbl">${esc(label)}</span><span class="val">${esc(override??planValue??'—')}</span><input class="streamInput" type="number" name="${esc(name)}" min="1" max="10" placeholder="Inherit" value="${override==null?'':esc(override)}"></div>`).join('');
  return `<details class="panel"><summary><span>Household networks</span><span class="chev">▸</span><span class="cnt">${rows.length} rule${rows.length===1?'':'s'}</span></summary><div class="panelBody"><form method="post" action="/admin/users/${encodeURIComponent(customerId)}/household-overrides">${csrfHidden(token)}<div class="denseList">${body}</div><div class="denseSaveRow"><button class="button primary sm" type="submit">Save</button></div></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/household-overrides/reset-all">${csrfHidden(token)}<button class="button secondary sm" type="submit">Reset to plan</button></form></div></details>`;
}

async function laneBlock(lane,entitlementRow,token,customerId,options={}){
  const planRow={...entitlementRow,request_permissions:entitlementRow.request_permissions};
  const effective=await laneEffective(customerId,lane,planRow);
  // Bundle plans deliver Jellyfin + Stremio as one combined lane, so their
  // household-network row belongs on the Stremio delivery block below
  // (stremioLaneBlock), not duplicated here too.
  const pureJellyfin=String(entitlementRow.service_type_snapshot||entitlementRow.service_type||'jellyfin').toLowerCase()==='jellyfin';
  const householdRows=pureJellyfin&&entitlementRow.jellyfin_access_model==='household_network'
    ?[['jellyfin','Jellyfin household networks',entitlementRow.jellyfin_household_network_limit,options.householdOverrides?.jellyfin?.network_limit??null]]:[];
  return `<div class="laneWrap"><div class="laneHead"><span class="pill accent">${esc(LANE_LABEL[lane]||lane)}</span><h4>${esc(entitlementRow.contract_plan_name||entitlementRow.name||'Active plan')}</h4></div><div class="twoCol"><div class="colStack">${accessControlsPanel(lane,token,customerId,effective.technicalRows)}${requestsPanel(token,customerId,effective.requestEffective)}${householdPanel(token,customerId,householdRows)}</div>${librariesPanel(lane,token,customerId,effective.entitlementRows,effective.failedServers)}</div></div>`;
}

async function stremioLaneBlock(detail,token,options){
  const customerId=detail.customer.id;
  const planRow=options.currentPlan||null;
  const requestEffective=await requestOverrides.effectivePermissions(customerId,planRow?.request_permissions);
  const stremioState=options.stremioInfo||{};
  const installBlock=manage.stremioSection?manage.stremioSection(detail,token,stremioState):'';
  const leaseForm=`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/stremio-household/reset" data-native-submit="true">${csrfHidden(token)}<button class="button secondary sm" type="submit">Reset Stremio IP lease</button></form>`;
  const householdRows=[];
  if(planRow?.jellyfin_access_model==='household_network')householdRows.push(['jellyfin','Jellyfin household networks',planRow.jellyfin_household_network_limit,options.householdOverrides?.jellyfin?.network_limit??null]);
  const service=String(planRow?.service_type_snapshot||planRow?.service_type||'stremio').toLowerCase();
  if(service==='stremio'||service==='bundle')householdRows.push(['stremio','Stremio household networks',planRow?.stremio_household_network_limit,options.householdOverrides?.stremio?.network_limit??null]);
  const householdBlock=householdPanel(token,customerId,householdRows);
  return `<div class="laneWrap"><div class="laneHead"><span class="pill accent">Stremio</span><h4>Stremio delivery</h4></div><div class="twoCol"><div class="colStack">${requestsPanel(token,customerId,requestEffective)}${householdBlock}</div><details class="panel" open><summary><span>Installation</span><span class="chev">▸</span><span class="cnt">Manifest &amp; IP lease</span></summary><div class="panelBody">${installBlock}<div class="denseSaveRow">${leaseForm}</div></div></details></div></div>`;
}

async function accessLibrariesRequests(detail,token,options={}){
  const customerId=detail.customer.id;
  const entitlements=await laneEntitlements(customerId);
  const blocks=[];
  if(entitlements.primary)blocks.push(await laneBlock('primary',entitlements.primary,token,customerId,options));
  if(entitlements.free)blocks.push(await laneBlock('free',entitlements.free,token,customerId,options));
  const bundleRow=[entitlements.primary,entitlements.free].find(row=>row&&String(row.service_type_snapshot||row.service_type||'').toLowerCase()==='bundle')||null;
  let stremioOnly=null;
  if(!entitlements.primary&&!entitlements.free){
    stremioOnly=await stremioEntitlementsSvc.entitledSubscription(customerId).catch(()=>null);
  }
  if(bundleRow||stremioOnly){
    blocks.push(await stremioLaneBlock(detail,token,{...options,currentPlan:options.currentPlan||bundleRow||stremioOnly}));
  }
  if(!blocks.length)return'';
  return `<section class="section"><div class="sectionHead"><div><h2>Access, libraries &amp; requests</h2><div class="muted">Plan defaults stay intact unless overridden — every row below is a live override, right here. Repeats per server this customer belongs to.</div></div></div><div class="sectionBody">${blocks.join('')}</div></section>`;
}

/* ==================================================================
   4. BILLING — record a manual payment, see payment history. ======= */

function billingSection(detail,token){
  const customerId=detail.customer.id;
  const manual=detail.manualPayments||[];
  const providerRows=(detail.subscriptions||[]).filter(s=>['stripe','paypal'].includes(s.source)).slice(0,20).map(s=>tr([td('Date',fmtDate(s.created_at)),td('Amount',esc(moneyFormat.formatMinor(s.price_minor||0,s.currency||'GBP'))),td('Source',pill(s.source,'accent'))]));
  const manualRows=manual.map(m=>tr([td('Date',fmtDate(m.created_at)),td('Amount',esc(moneyFormat.formatMinor(m.amount_minor,m.currency))),td('Source',pill(billing.METHOD_LABELS[m.method]||m.method,'good')+(m.note?`<div class="subText">${esc(m.note)}</div>`:''))]));
  const rows=[...manualRows,...providerRows].slice(0,25);
  const currencyOptions=billing.CURRENCIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const methodOptions=Object.entries(billing.METHOD_LABELS).map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
  return `<section class="section"><div class="sectionHead"><div><h2>Billing</h2><div class="muted">Record a manual payment, or check the customer's payment history.</div></div></div><div class="sectionBody"><div class="billingGrid"><div class="billingCard"><h4>Record manual payment</h4><p class="hint">For cash, bank transfer or anything paid outside Stripe/PayPal. Does not change subscription or expiry — use the Customer control cards above for that.</p><form method="post" action="/admin/users/${encodeURIComponent(customerId)}/manual-payment">${csrfHidden(token)}<div class="formRow"><div class="formGroup"><label>Amount</label><input class="input" name="amount" placeholder="20.00" required></div><div class="formGroup"><label>Currency</label><select class="input" name="currency">${currencyOptions}</select></div></div><div class="formRow"><div class="formGroup"><label>Method</label><select class="input" name="method">${methodOptions}</select></div><div class="formGroup"><label>Note</label><input class="input" name="note" maxlength="500" placeholder="Optional"></div></div><button class="button primary" type="submit">Record payment</button></form></div><div class="billingCard"><h4>Payment history</h4><p class="hint">Manual and provider payments, most recent first.</p>${table(['Date','Amount','Source'],rows)}</div></div></div></section>`;
}

/* ==================================================================
   5. PROVISIONING HISTORY (capped) & ACTIVITY — unchanged log
   sections; logs stay tables, not cards. ============================ */

function accountDetails(detail){
  const accounts=(detail.accounts||[]).filter(a=>String(a.account_purpose||'jellyfin')!=='stremio_internal');
  if(!accounts.length)return'';
  const rows=accounts.map(account=>tr([td('Username',`<strong>${esc(account.jellyfin_username)}</strong>`),td('Server',esc(account.server_name||'—')),td('Health',pill(account.health_status||'unknown',account.health_status==='healthy'?'good':account.health_status==='offline'?'bad':'warn')),td('Status',pill(account.disabled?'Disabled':'Enabled',account.disabled?'bad':'good')),td('Reconcile',pill(account.recon_status||'Not run',account.recon_status==='successful'?'good':account.recon_status==='failed'?'bad':'warn')),td('Last activity',esc(fmtDate(account.last_activity_at))) ]));
  return `<section class="section"><div class="sectionHead"><div><h2>Jellyfin account details</h2><div class="muted">Server health, reconciliation and last activity.</div></div></div><div class="sectionBody">${table(['Username','Server','Health','Status','Reconcile','Last activity'],rows)}</div></section>`;
}

function provisioningHistory(detail){
  const runs=(detail.runs||[]).slice(0,50),failed=runs.filter(run=>run.status==='failed').length,visible=runs.slice(0,6),rest=runs.slice(6);
  const runRow=run=>tr([td('Started',esc(fmtDate(run.started_at))),td('Action',esc(run.action)),td('Status',pill(run.status,run.status==='succeeded'?'good':run.status==='failed'?'bad':'warn')),td('Completed',esc(fmtDate(run.completed_at)))]);
  const rows=visible.map(runRow);
  const remainder=rest.length?`<details class="logCapDetails"><summary>${rest.length} earlier event${rest.length===1?'':'s'} not shown</summary>${table(['Started','Action','Status','Completed'],rest.map(runRow))}</details>`:'';
  return `<section class="section"><div class="sectionHead"><div><h2>Provisioning history</h2><div class="muted">${runs.length} event${runs.length===1?'':'s'}${failed?` — ${failed} failed`:''}</div></div></div><div class="sectionBody">${table(['Started','Action','Status','Completed'],rows)}${remainder}</div></section>`;
}

function activitySection(detail){
  const active=detail.activeStreams||[],history=(detail.playback||[]).slice(0,30),sessions=Number(detail.activitySummary?.sessions_30d||0),last=detail.activitySummary?.last_playback_at;
  const activeRows=active.map(item=>tr([td('Now',`<strong>${esc(item.item_name||'Unknown')}</strong>`),td('Client',esc(item.client_name||'—')),td('Method',pill(item.playback_method||'—',item.playback_method==='transcode'?'warn':'good')),td('Server',esc(item.server_name||'—')),td('Last seen',esc(fmtDate(item.last_seen_at)))]));
  const historyRows=history.map(item=>tr([td('Started',esc(fmtDate(item.started_at))),td('Item',`<strong>${esc(item.item_name||'Unknown')}</strong>`),td('Client',esc(item.client_name||'—')),td('Method',pill(item.playback_method||'—',item.playback_method==='transcode'?'warn':'good')),td('Server',esc(item.server_name||'—'))]));
  const body=`${active.length?`<h3>Playing now</h3>${table(['Item','Client','Method','Server','Last seen'],activeRows)}`:''}<h3>Recent playback</h3>${table(['Started','Item','Client','Method','Server'],historyRows)}`;
  return `<section class="section"><div class="sectionHead"><div><h2>Activity</h2><div class="muted">${active.length?`${active.length} active now`:sessions?`${sessions} sessions / 30d`:'No recent playback.'}${last?` — Last playback ${fmtDate(last)}`:''}</div></div></div><div class="sectionBody">${body}</div></section>`;
}

function styles(){return `<style>
.ctlGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}
.ctlCard{border:1px solid var(--border,#29333d);border-radius:10px;padding:12px 13px;display:flex;flex-direction:column;gap:4px;background:rgba(255,255,255,.018);min-height:108px}
.ctlNum{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:color-mix(in srgb,var(--h-customers) 18%,transparent);color:var(--h-customers);font-size:10px;font-weight:800;margin-bottom:4px}
.ctlTop{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.ctlLabel{display:block;font-size:.68rem;color:var(--muted,#9aa7b5);text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:3px}
.ctlTop strong{font-size:.92rem;line-height:1.2}
.ctlSub{font-size:.72rem;color:var(--muted,#9aa7b5);flex:1;overflow-wrap:anywhere}
.ctlActions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ctlActions .button{padding:6px 8px;font-size:.72rem;min-height:0}
.ctlInlineForm{display:flex;gap:5px;flex-wrap:wrap;width:100%}
.ctlInlineForm select{min-width:0;flex:1}
.ctlNote{font-size:.72rem;color:var(--muted,#9aa7b5)}
.ctlMoreList{display:flex;flex-direction:column;gap:5px}
.ctlMoreList .button,.ctlMoreList summary.button{width:100%;text-align:left}
.laneWrap{margin-bottom:20px}.laneWrap:last-child{margin-bottom:0}
.laneHead{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.laneHead h4{margin:0;font-size:.85rem;font-weight:800}
.twoCol{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.colStack{display:flex;flex-direction:column;gap:12px}
details.panel{border:1px solid var(--border,#29333d);border-radius:10px;overflow:hidden;background:rgba(255,255,255,.012)}
details.panel summary{display:flex;align-items:center;gap:10px;padding:10px 13px;cursor:pointer;list-style:none;font-size:.8rem;font-weight:800}
details.panel summary::-webkit-details-marker{display:none}
details.panel summary .chev{color:var(--muted,#9aa7b5);font-size:.7rem;transition:transform .12s ease}
details.panel[open] summary .chev{transform:rotate(90deg)}
details.panel summary .cnt{margin-left:auto;color:var(--muted,#9aa7b5);font-weight:600;font-size:.72rem}
.panelBody{border-top:1px solid var(--border,#29333d);padding:12px}
.denseList{border:1px solid var(--border,#29333d);border-radius:8px;overflow:hidden}
.groupHead{display:flex;justify-content:space-between;padding:6px 10px;background:color-mix(in srgb,var(--h-customers) 6%,transparent);font-size:.66rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#9aa7b5);font-weight:800;border-bottom:1px solid var(--border,#29333d)}
.denseRow{display:grid;grid-template-columns:minmax(0,1fr) 78px 168px;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border,#29333d);font-size:.76rem}
.denseRow:last-child{border-bottom:0}
.denseRow .lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.denseRow .val{color:var(--muted,#9aa7b5);text-align:right;white-space:nowrap;font-size:.7rem}
.segmented{display:flex;gap:2px;padding:1px;border:1px solid var(--border,#29333d);border-radius:6px}
.segChoice{position:relative;flex:1}
.segChoice input{position:absolute;opacity:0;pointer-events:none}
.segChoice span{display:block;text-align:center;border-radius:4px;padding:3px 4px;font-size:.66rem;cursor:pointer}
.segChoice input:checked+span{background:color-mix(in srgb,var(--h-customers) 18%,transparent);color:var(--text,#e4e9ed);font-weight:700}
.segChoice input:focus-visible+span{outline:2px solid var(--focus,#7fb3d5);outline-offset:1px}
.streamInput{width:168px;min-height:26px;border:1px solid var(--border,#29333d);border-radius:6px;padding:2px 7px;font-size:.72rem;text-align:right;background:transparent;color:inherit}
.denseSaveRow{display:flex;gap:8px;margin-top:8px}
.billingGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.billingCard{border:1px solid var(--border,#29333d);border-radius:10px;padding:14px;background:rgba(255,255,255,.012)}
.billingCard h4{margin:0 0 3px;font-size:.85rem;font-weight:800}
.billingCard .hint{margin:0 0 10px;font-size:.72rem;color:var(--muted,#9aa7b5)}
.formRow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.logCapDetails{margin-top:10px;padding-top:10px;border-top:1px solid var(--border,#29333d)}
.logCapDetails summary{cursor:pointer;color:var(--muted,#9aa7b5);font-size:.76rem;list-style:none}
.logCapDetails summary::-webkit-details-marker{display:none}
.logCapDetails[open] summary{margin-bottom:8px}
.accessAssignCard{margin:12px 0;border:1px solid var(--border,#29333d);background:rgba(255,255,255,.018);border-radius:10px;padding:14px}
.accessAssignHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
.accessAssignHead div{display:grid;gap:3px}
.accessAssignHead span:not(.pill){color:var(--muted,#9aa7b5);font-size:.82rem}
.accessAssignForm{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:10px}
.accessControlGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.accessControlCard{border:1px solid var(--border,#29333d);background:rgba(255,255,255,.018);border-radius:10px;padding:12px}
.accessControlHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.accessEyebrow{display:block;font-size:.72rem;letter-spacing:.055em;text-transform:uppercase;color:var(--muted,#9aa7b5);font-weight:700}
@media(max-width:1150px){.ctlGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.twoCol{grid-template-columns:1fr}}
@media(max-width:760px){.ctlGrid{grid-template-columns:1fr}.denseRow{grid-template-columns:minmax(0,1fr) 140px}.denseRow .val{display:none}.billingGrid,.formRow{grid-template-columns:1fr}}
</style>`;}

async function render(detail,token,options={}){
  if(!detail?.customer?.id)return'';
  const operatorContext=require('./admin-customer-operator').context;
  const ctx=await operatorContext(detail.customer.id,options.req).catch(()=>null);
  const manualPayments=await billing.manualPayments(detail.customer.id).catch(()=>[]);
  const withManual={...detail,manualPayments};
  const laneBlocks=await accessLibrariesRequests(detail,token,options).catch(error=>`<section class="section"><div class="notice error">Access, libraries &amp; requests could not be loaded. ${esc(String(error?.message||'Try again.').slice(0,200))}</div></section>`);
  return `${styles()}${controlGrid(detail,token,ctx,options.permanent)}${accessStatusSection(detail,token)}${laneBlocks}${billingSection(withManual,token)}${accountDetails(detail)}${provisioningHistory(detail)}${activitySection(detail)}`;
}

module.exports={render,controlGrid,accessLibrariesRequests,billingSection,accountDetails,provisioningHistory,activitySection,styles};
