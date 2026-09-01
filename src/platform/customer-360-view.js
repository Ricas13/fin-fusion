'use strict';

const v2=require('./customer-360-view-v2');
const manage=require('./admin-customer-management');
const accessCards=require('./customer-360-access-cards');

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

function body(detail,tab,token,accessDetail,options={}){
  const safe=customerFacingDetail(detail),type=serviceType(detail).toLowerCase();
  if(tab!=='access')return v2.body(safe,tab,token,accessDetail,options);

  // Render only Customer 360's shared hero/summary/tab chrome. The old Access
  // implementation is deliberately skipped so the card workspace below is the
  // single owner of Jellyfin policy, libraries, history and activity on this tab.
  const chrome=v2.body(safe,'access',token,accessDetail,{...options,skipAccessSections:true});
  if(type==='stremio')return chrome+stremioAccessPanel(safe)+stremioHouseholdSection(safe,token,accessDetail?.currentPlan,options)+stremioInstallSection(safe,token,options);
  const jellyfin=chrome+accessCards.render(safe,token,accessDetail,options);
  return type==='bundle'?jellyfin+stremioInstallSection(safe,token,options):jellyfin;
}

module.exports={...v2,body,serviceType,customerFacingDetail,jellyfinPasswordSupport,activeSubscription,accessWorkspaceSection,manualServerAssignmentForm,assignmentCapacityLabel,reenableJellyfinForm};
