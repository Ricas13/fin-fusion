'use strict';

const v2=require('./customer-360-view-v2');
const manage=require('./admin-customer-management');
const accessCards=require('./customer-360-access-cards');
const accessStatus=require('./customer-360-access-status');
const serviceTruth=require('./customer-360-service-truth');
const desiredState=require('../entitlements/customer-access-desired-state');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;}
function reenableJellyfinForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/jellyfin/re-enable" data-native-submit="true">${csrfHidden(token)}<button class="button primary" type="submit">Re-enable Jellyfin access</button></form>`;}
function jellyfinPasswordSupport(detail){
  const customerId=detail?.customer?.id,accounts=(detail?.accounts||[]).filter(account=>!account.disabled&&String(account.account_purpose||'jellyfin')!=='stremio_internal');
  if(!customerId||!accounts.length)return'';
  return `<section class="section"><div class="sectionHead"><div><h2>Jellyfin password support</h2><div class="muted">Help this customer change a Jellyfin password without exposing or storing the plaintext password in CAPTAiNFiN.</div></div><a class="button secondary" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}">Change Jellyfin password</a></div></section>`;
}
function stremioAccessPanel(detail){
  const entitlement=detail.primaryEntitlement||detail.subscriptions?.[0]||{},name=entitlement.name||entitlement.plan_name||entitlement.plan_name_snapshot||'Stremio access';
  return `<section class="section"><div class="sectionHead"><div><h2>Stremio access</h2><div class="muted">This customer has a Stremio-only primary plan, so Jellyfin policy, libraries and server placement do not apply.</div></div><span class="pill good">${String(entitlement.status||'active')==='past_due'?'Payment attention':'Included'}</span></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Current delivery</h2></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Plan</div><div class="kvValue">${escapeHtml(name)}</div></div><div class="kvRow"><div class="kvLabel">Service</div><div class="kvValue">Stremio</div></div><div class="kvRow"><div class="kvLabel">Customer Jellyfin account</div><div class="kvValue">Not required</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Manage Stremio</h2></div><div class="profileCardBody"><p class="subText">Customer-specific Stremio installation and household limits are managed here. Source connections and indexing remain global server settings.</p><a class="button secondary" href="/admin/servers/stremio">Open global Stremio settings</a></div></section></div></section>`;
}
function stremioHouseholdSection(detail,token,currentPlan,options={}){
  const customerId=detail?.customer?.id,planDefault=currentPlan?.stremio_household_network_limit,override=options.householdOverrides?.stremio?.network_limit??null;
  if(!customerId||(planDefault==null&&override==null))return'';
  const hasOverride=override!=null,effective=hasOverride?override:planDefault;
  return `<details class="section compactDisclosure"><summary class="sectionHead"><div><h2>Stremio household network</h2><div class="muted">Plan ${escapeHtml(planDefault??'—')} · Effective ${escapeHtml(effective??'—')}</div></div><span class="pill accent">${hasOverride?'Customer override':'Plan default'}</span></summary><div class="compactDisclosureBody"><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/household-overrides">${csrfHidden(token)}<div class="formGroup"><label>Household network limit</label><input class="input compact" type="number" name="stremio" min="1" max="10" placeholder="Inherit" value="${hasOverride?escapeHtml(override):''}"></div><div class="buttonRow"><button class="button">Save override</button></div></form></div></details>`;
}
function stremioInstallSection(detail,token,options={}){return options.stremioInfo?manage.stremioSection(detail,token,options.stremioInfo):'';}
function accessWorkspaceSection(detail,token,accessDetail){return accessCards.accessOverview(detail,token,accessDetail);}
function manualServerAssignmentForm(token,customerId,assignment){return accessCards.manualAssignmentForm(token,customerId,assignment);}
function assignmentCapacityLabel(server){return accessCards.assignmentCapacityLabel(server);}
function stripLegacyReconcileForms(html,customerId){
  const action=`/admin/users/${encodeURIComponent(customerId)}/manage/reconcile`;
  const escaped=action.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return String(html||'').replace(new RegExp(`<form class="plainForm" method="post" action="${escaped}"[^>]*>[\\s\\S]*?<\\/form>`,'g'),'');
}

function desiredAccessForDetail(detail,entitlement){
  const type=String(entitlement?.service_type_snapshot||entitlement?.service_type||serviceType(detail)||'jellyfin').toLowerCase();
  const input={holds:Array.isArray(detail.activeHolds)?detail.activeHolds:[]};
  if(type==='stremio')input.stremioEntitlement=entitlement;
  else if(type==='emby')input.embyEntitlement=entitlement;
  else if(entitlement?.is_free_tier)input.freeEntitlement=entitlement;
  else input.effectiveJellyfin=entitlement;
  return desiredState.deriveCustomerAccessDesiredState(input);
}

function serviceTruthPanel(detail){
  const rows=serviceTruth.resultRows(detail);
  const rowHtml=rows.map(row=>{
    const desiredTone=/blocked/i.test(row.desired)?'warn':/enabled|synced/i.test(row.desired)?'good':'';
    const actualTone=/active|enabled|synced|healthy/i.test(row.actual)?'good':/blocked|failed|disabled|inactive|error/i.test(row.actual)?'bad':'';
    const when=row.reconciledAt?new Date(row.reconciledAt):null;
    const whenText=when&&!Number.isNaN(when.getTime())?when.toLocaleString('en-GB'):'No completed reconciliation';
    return `<tr><td><strong>${escapeHtml(row.service)}</strong><div class="muted">${escapeHtml(row.plan)}</div></td><td><span class="pill ${desiredTone}">${escapeHtml(row.desired)}</span></td><td><span class="pill ${actualTone}">${escapeHtml(row.actual)}</span></td><td>${escapeHtml(row.target)}</td><td>${row.issue?`<span class="pill warn">${escapeHtml(row.issue)}</span>`:'—'}</td><td>${escapeHtml(whenText)}</td></tr>`;
  }).join('');
  return `<section class="section customerServiceTruth"><div class="sectionHead"><div><h2>Service reconciliation truth</h2><div class="muted">Desired and observed state by service, derived from the canonical reconciliation snapshot. “No reconciliation snapshot” means the service has not yet produced an observed result—not that access is healthy.</div></div></div><div class="tableWrap"><table class="table"><thead><tr><th>Service / plan</th><th>Desired</th><th>Observed</th><th>Account / server</th><th>Blocker / error</th><th>Last reconciled</th></tr></thead><tbody>${rowHtml}</tbody></table></div></section>`;
}

function accessTruthPanel(detail){
  const entitlement=detail.primaryEntitlement||activeSubscription(detail)||null;
  const accessIntent=desiredAccessForDetail(detail,entitlement);
  const holds=accessIntent.blockers;
  const ordinaryAccounts=(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal');
  const enabledAccounts=ordinaryAccounts.filter(account=>!account.disabled);
  const state=detail.provisioningState||null;
  const planName=entitlement?.contract_plan_name||entitlement?.plan_name||entitlement?.name||entitlement?.plan_name_snapshot||entitlement?.contract_plan_code||entitlement?.plan_code||'No current entitlement';
  const commercialStatus=entitlement?String(entitlement.status||entitlement.subscription_status||'effective'):'none';
  const desired=!entitlement?'No current entitlement':holds.length?`Blocked by ${holds.length} active hold${holds.length===1?'':'s'}`:accessIntent.desiredAnyAccess?'Entitled / no active holds':'Entitlement currently blocked';
  const holdDetail=holds.length?holds.map(hold=>hold.type||'hold').join(', '):'None';
  const serverDetail=enabledAccounts.length?enabledAccounts.map(account=>account.server_name||account.jellyfin_username||'Jellyfin').join(', '):ordinaryAccounts.length?'All ordinary Jellyfin accounts disabled':'No ordinary Jellyfin account';
  const reconcileStatus=state?.status||'No reconciliation state';
  const reconcileDetail=state?.last_error?state.last_error:(state?.last_success_at?`Last success ${new Date(state.last_success_at).toLocaleString('en-GB')}`:(state?.last_attempt_at?`Last attempt ${new Date(state.last_attempt_at).toLocaleString('en-GB')}`:'No completed reconciliation recorded'));
  const statusTone=holds.length||entitlement&&!accessIntent.desiredAnyAccess?'warn':entitlement?'good':'';
  const reconTone=['failed','blocked'].includes(String(state?.status||''))?'bad':String(state?.status||'')==='healthy'?'good':'';
  return `<section class="section customerAccessTruth"><div class="sectionHead"><div><h2>Access truth</h2><div class="muted">Commercial entitlement, blockers, actual Jellyfin state and the last reconciliation result are shown separately so support can see why access is in its current state.</div></div><a class="button secondary btn-sm" href="/admin/users/${encodeURIComponent(detail.customer.id)}?tab=access">Open Access</a></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Commercial state</h2><span class="pill ${entitlement?'good':''}">${escapeHtml(commercialStatus)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Entitlement</div><div class="kvValue">${escapeHtml(planName)}</div></div><div class="kvRow"><div class="kvLabel">Effective access</div><div class="kvValue"><span class="pill ${statusTone}">${escapeHtml(desired)}</span></div></div><div class="kvRow"><div class="kvLabel">Active blockers</div><div class="kvValue">${escapeHtml(holdDetail)}</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Observed state</h2><span class="pill ${enabledAccounts.length?'good':ordinaryAccounts.length?'warn':''}">${escapeHtml(`${enabledAccounts.length}/${ordinaryAccounts.length} enabled`)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Jellyfin</div><div class="kvValue">${escapeHtml(serverDetail)}</div></div><div class="kvRow"><div class="kvLabel">Reconciliation</div><div class="kvValue"><span class="pill ${reconTone}">${escapeHtml(reconcileStatus)}</span></div></div><div class="kvRow"><div class="kvLabel">Last result</div><div class="kvValue">${escapeHtml(reconcileDetail)}</div></div></div></div></section></div></section>${serviceTruthPanel(detail)}`;
}

function body(detail,tab,token,accessDetail,options={}){
  const safe=customerFacingDetail(detail),type=serviceType(detail).toLowerCase();
  if(tab!=='access'){
    const rendered=v2.body(safe,tab,token,accessDetail,options);
    return tab==='overview'?rendered.replace('</nav>',`</nav>${accessTruthPanel(safe)}`):rendered;
  }

  // Render only Customer 360's shared hero/summary/tab chrome. The old Access
  // implementation is deliberately skipped so the card workspace below is the
  // single owner of Jellyfin policy, libraries, history and activity on this tab.
  // Portal onboarding remains owned by Overview/claim workflows; duplicating it
  // here creates competing account-management surfaces.
  const chrome=v2.body(safe,'access',token,accessDetail,{...options,skipAccessSections:true});
  const status=accessStatus.render(safe,token);
  if(type==='stremio')return chrome+status+stremioAccessPanel(safe)+stremioHouseholdSection(safe,token,accessDetail?.currentPlan,options)+stremioInstallSection(safe,token,options);
  const jellyfin=chrome+status+stripLegacyReconcileForms(accessCards.render(safe,token,accessDetail,options),safe.customer.id);
  return type==='bundle'?jellyfin+stremioInstallSection(safe,token,options):jellyfin;
}

module.exports={...v2,body,serviceType,customerFacingDetail,jellyfinPasswordSupport,activeSubscription,desiredAccessForDetail,accessTruthPanel,serviceTruthPanel,accessWorkspaceSection,manualServerAssignmentForm,assignmentCapacityLabel,reenableJellyfinForm,stripLegacyReconcileForms};
