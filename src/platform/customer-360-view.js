'use strict';

const v2=require('./customer-360-view-v2');
const accessCards=require('./customer-360-access-cards');
const compact=require('./customer-360-compact');
const primaryActions=require('./admin-customer-primary-actions');
const desiredState=require('../entitlements/customer-access-desired-state');
const serviceTruth=require('./customer-360-service-truth');
const moneyFormat=require('./money-format');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;}
function fmtDate(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});}
function initials(value){const parts=String(value||'U').trim().split(/\s+/).filter(Boolean);if(parts.length>1)return(parts[0][0]+parts[parts.length-1][0]).toUpperCase();return String(parts[0]||'U').slice(0,2).toUpperCase();}

function accessWorkspaceSection(detail,token,accessDetail){
  const sub=activeSubscription(detail);
  const accounts=(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal');
  const ctx=sub?{entitlement:{planName:sub.plan_name,serverClass:sub.server_class,isFreeTier:Boolean(sub.is_free_tier),serviceType:sub.service_type},accounts,activeAccounts:accounts.filter(account=>!account.disabled),servers:[],adminControl:null,serviceKind:sub.service_type||'jellyfin'}:null;
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

function serviceTruthPanel(detail){
  const rows=serviceTruth.resultRows(detail);
  const rowHtml=rows.map(row=>{const desiredTone=/blocked/i.test(row.desired)?'warn':/enabled|synced/i.test(row.desired)?'good':'';const actualTone=/active|enabled|synced|healthy/i.test(row.actual)?'good':/blocked|failed|disabled|inactive|error/i.test(row.actual)?'bad':'';const when=row.reconciledAt?new Date(row.reconciledAt):null;const whenText=when&&!Number.isNaN(when.getTime())?when.toLocaleString('en-GB'):'No completed reconciliation';return `<tr><td><strong>${escapeHtml(row.service)}</strong><div class="muted">${escapeHtml(row.plan)}</div></td><td><span class="pill ${desiredTone}">${escapeHtml(row.desired)}</span></td><td><span class="pill ${actualTone}">${escapeHtml(row.actual)}</span></td><td>${escapeHtml(row.target)}</td><td>${row.issue?`<span class="pill warn">${escapeHtml(row.issue)}</span>`:'—'}</td><td>${escapeHtml(whenText)}</td></tr>`;}).join('');
  return `<section class="section customerServiceTruth"><div class="sectionHead"><div><h2>Service reconciliation truth</h2><div class="muted">Desired and observed state by service, derived from the canonical reconciliation snapshot.</div></div></div><div class="tableWrap"><table class="table"><thead><tr><th>Service / plan</th><th>Desired</th><th>Observed</th><th>Account / server</th><th>Blocker / error</th><th>Last reconciled</th></tr></thead><tbody>${rowHtml}</tbody></table></div></section>`;
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
  return `<section class="section customerAccessTruth"><div class="sectionHead"><div><h2>Access truth</h2></div></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Commercial state</h2><span class="pill ${entitlement?'good':''}">${escapeHtml(commercialStatus)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Entitlement</div><div class="kvValue">${escapeHtml(planName)}</div></div><div class="kvRow"><div class="kvLabel">Effective access</div><div class="kvValue"><span class="pill ${statusTone}">${escapeHtml(desired)}</span></div></div><div class="kvRow"><div class="kvLabel">Active blockers</div><div class="kvValue">${escapeHtml(holdDetail)}</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Observed state</h2><span class="pill ${enabledAccounts.length?'good':ordinaryAccounts.length?'warn':''}">${escapeHtml(`${enabledAccounts.length}/${ordinaryAccounts.length} enabled`)}</span></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Jellyfin</div><div class="kvValue">${escapeHtml(serverDetail)}</div></div><div class="kvRow"><div class="kvLabel">Reconciliation</div><div class="kvValue"><span class="pill ${reconTone}">${escapeHtml(reconcileStatus)}</span></div></div><div class="kvRow"><div class="kvLabel">Last result</div><div class="kvValue">${escapeHtml(reconcileDetail)}</div></div></div></div></section></div></section>${serviceTruthPanel(detail)}`;
}

function mockHero(detail,token,permanent){
  const c=detail.customer||{},sub=activeSubscription(detail),name=c.display_name||c.login_username||c.login_email||c.email||'Managed customer';
  const email=c.login_email||c.email||'No email';
  const isPermanent=Boolean(permanent?.active||permanent?.stale);
  const paid=Boolean(sub&&!sub.is_free_tier&&['active','trialing','past_due','paused'].includes(String(sub.status||'')));
  const customerStatus=isPermanent?'Permanent User':sub?.is_free_tier?'Free User':paid?'Regular User':'No active plan';
  const statusTone=isPermanent?'warn':paid||sub?.is_free_tier?'good':'';
  const statusSub=isPermanent?'Admin-managed permanent access':paid?'Managed by automation':sub?.is_free_tier?'Managed by Free Server rules':'No automatic entitlement';
  const renewal=sub?.current_period_end?fmtDate(sub.current_period_end):'—';
  const price=sub&&sub.price_minor!=null?moneyFormat.formatMinor(sub.price_minor,sub.currency||'GBP'):'—';
  const customerSince=fmtDate(c.registered_at||c.created_at);
  const idShort=String(c.id||'').slice(0,8)||'—';
  const portal=c.app_user_id?`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(c.id)}/impersonate">${csrfHidden(token)}<button class="mockTopButton primary" type="submit">View customer on portal ↗</button></form>`:'';
  const edit=`<a class="mockTopButton" href="/admin/users/${encodeURIComponent(c.id)}/edit-profile">Edit</a>`;
  const permanentRemove=isPermanent?`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(c.id)}/manage/remove-permanent-user" data-native-submit="true">${csrfHidden(token)}<button class="mockInlineDanger" type="submit">Remove Permanent User</button></form>`:'';
  return `<style>
  .customerMockHero{display:grid;grid-template-columns:minmax(390px,1.2fr) minmax(520px,1.8fr);gap:22px;align-items:end;margin:4px 0 10px}.customerMockIdentity{display:grid;grid-template-columns:72px minmax(0,1fr);gap:18px;align-items:center;min-width:0}.customerMockAvatar{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;font-size:1.7rem;font-weight:700;background:linear-gradient(145deg,rgba(130,89,167,.72),rgba(70,45,88,.78));border:1px solid rgba(255,255,255,.08)}.customerMockName{display:flex;align-items:center;gap:8px}.customerMockName h1{margin:0;font-size:1.35rem;line-height:1}.customerMockEmail{font-size:.82rem;color:#aebdcc;margin-top:6px}.customerMockMeta{display:flex;gap:7px;flex-wrap:wrap;font-size:.65rem;color:var(--muted,#8796a5);margin-top:8px}.customerMockPills{display:flex;gap:6px;margin-top:8px}.customerMockRight{display:grid;gap:8px}.customerMockTopActions{display:flex;justify-content:flex-end;gap:7px}.mockTopButton{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:6px 12px;border:1px solid #344657;border-radius:7px;background:#111a22;color:#dce7ef;text-decoration:none;font-size:.7rem;font-weight:700}.mockTopButton.primary{border-color:#29aef0}.customerMockMetrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.customerMockMetric{border:1px solid #263644;border-radius:8px;background:#111b24;padding:10px 12px;min-height:72px;display:grid;align-content:center}.customerMockMetric small{font-size:.62rem;color:#93a3b2}.customerMockMetric strong{font-size:.88rem;margin-top:5px}.customerMockMetric span{font-size:.62rem;color:#899aa9;margin-top:3px}.customerMockStatusRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.mockInlineDanger{border:0;background:transparent;color:#ff7c84;font-size:.59rem;padding:0;text-decoration:underline;cursor:pointer}.customerLegacyNav{display:none!important}@media(max-width:1180px){.customerMockHero{grid-template-columns:1fr}.customerMockTopActions{justify-content:flex-start}}@media(max-width:760px){.customerMockIdentity{grid-template-columns:56px 1fr}.customerMockAvatar{width:56px;height:56px}.customerMockMetrics{grid-template-columns:repeat(2,1fr)}}
  </style><section class="customerMockHero"><div class="customerMockIdentity"><div class="customerMockAvatar">${escapeHtml(initials(name))}</div><div><div class="customerMockName"><h1>${escapeHtml(name)}</h1></div><div class="customerMockEmail">${escapeHtml(email)}</div><div class="customerMockMeta"><span>Customer since ${escapeHtml(customerSince)}</span><span>·</span><span>ID: ${escapeHtml(idShort)}</span><span>·</span><span>${escapeHtml(c.registration_source||'Source unknown')}</span></div><div class="customerMockPills"><span class="pill good">${c.login_active===false?'Portal disabled':'Active customer'}</span>${c.email_verified_at?'<span class="pill">✓ Verified</span>':''}</div></div></div><div class="customerMockRight"><div class="customerMockTopActions">${portal}${edit}<button class="mockTopButton" type="button" title="More customer actions">•••</button></div><div class="customerMockMetrics"><div class="customerMockMetric"><small>Current plan</small><strong>${escapeHtml(sub?.plan_name||'None')}</strong><span>${sub?`${escapeHtml(String(sub.status||'active'))} · ${escapeHtml(sub.streams||0)} streams`:'No active subscription'}</span></div><div class="customerMockMetric"><small>Next renewal</small><strong>${escapeHtml(renewal)}</strong><span>${sub?.cancel_at_period_end?'Renewal stopped':'Current period end'}</span></div><div class="customerMockMetric"><small>Total renewal</small><strong>${escapeHtml(price)}</strong><span>${sub?.source?escapeHtml(String(sub.source)):'No provider payment'}</span></div><div class="customerMockMetric"><small>Customer status</small><div class="customerMockStatusRow"><span class="pill ${statusTone}">${escapeHtml(customerStatus)}</span>${permanentRemove}</div><span>${escapeHtml(statusSub)}</span></div></div></div></section>`;
}

async function body(detail,token,options={}){
  if(!detail?.customer?.id)return'';
  const safe=customerFacingDetail(detail);
  const heroSummary=mockHero(safe,token,options.permanent);
  const navBar=v2.nav(safe.customer.id,token,safe.customer.app_user_id);
  const actions=await primaryActions.panel(safe,token,options.req,options.permanent).catch(()=> '');
  const main=await compact.render(safe,token,options);
  return `${heroSummary}<div class="customerLegacyNav">${navBar}</div>${actions}${main}`;
}

module.exports={...v2,body,serviceType,customerFacingDetail,activeSubscription,desiredAccessForDetail,accessTruthPanel,serviceTruthPanel,accessWorkspaceSection,mockHero};