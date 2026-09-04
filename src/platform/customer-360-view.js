'use strict';

const v2=require('./customer-360-view-v2');
const accessCards=require('./customer-360-access-cards');
const compact=require('./customer-360-compact');
const desiredState=require('../entitlements/customer-access-desired-state');
const serviceTruth=require('./customer-360-service-truth');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}

// DB-free adapter retained for callers/tests that only have detail data.
function accessWorkspaceSection(detail,token,accessDetail){
  const sub=activeSubscription(detail);
  const accounts=(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal');
  const ctx=sub?{
    entitlement:{planName:sub.plan_name,serverClass:sub.server_class,isFreeTier:Boolean(sub.is_free_tier),serviceType:sub.service_type},
    accounts,activeAccounts:accounts.filter(account=>!account.disabled),servers:[],adminControl:null,
    serviceKind:sub.service_type||'jellyfin'
  }:null;
  return accessCards.controlGrid(detail,token,ctx,accessDetail?.permanent||null);
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

// Retained as diagnostic helpers for direct callers, but deliberately no
// longer included on the default Customer 360 page.
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
  return `<section class="section customerAccessTruth"><div class="sectionHead"><div><h2>Access truth</h2><div class="muted">Commercial entitlement, blockers, actual Jellyfin state and the last reconciliation result are shown separately so support can see why access is in its current state.</div></div></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Commercial state</h2><span class="pill ${entitlement?'good':''}">${escapeHtml(commercialStatus)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Entitlement</div><div class="kvValue">${escapeHtml(planName)}</div></div><div class="kvRow"><div class="kvLabel">Effective access</div><div class="kvValue"><span class="pill ${statusTone}">${escapeHtml(desired)}</span></div></div><div class="kvRow"><div class="kvLabel">Active blockers</div><div class="kvValue">${escapeHtml(holdDetail)}</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Observed state</h2><span class="pill ${enabledAccounts.length?'good':ordinaryAccounts.length?'warn':''}">${escapeHtml(`${enabledAccounts.length}/${ordinaryAccounts.length} enabled`)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Jellyfin</div><div class="kvValue">${escapeHtml(serverDetail)}</div></div><div class="kvRow"><div class="kvLabel">Reconciliation</div><div class="kvValue"><span class="pill ${reconTone}">${escapeHtml(reconcileStatus)}</span></div></div><div class="kvRow"><div class="kvLabel">Last result</div><div class="kvValue">${escapeHtml(reconcileDetail)}</div></div></div></div></section></div></section>${serviceTruthPanel(detail)}`;
}

// Focused Customer 360: identity/summary, one portal entry, compact customer
// controls, collapsed access workspace, Billing, Activity, then a subdued
// collapsed provisioning log. Legacy duplicate profile/security/history/
// provider panels remain available through their dedicated admin surfaces,
// rather than repeating them below this support workspace.
async function body(detail,token,options={}){
  if(!detail?.customer?.id)return'';
  const safe=customerFacingDetail(detail);
  const heroSummary=v2.heroAndSummary(safe);
  const navBar=v2.nav(safe.customer.id,token,safe.customer.app_user_id);
  const main=await compact.render(safe,token,options);
  return `${heroSummary}${navBar}${main}`;
}

module.exports={...v2,body,serviceType,customerFacingDetail,activeSubscription,desiredAccessForDetail,accessTruthPanel,serviceTruthPanel,accessWorkspaceSection};
