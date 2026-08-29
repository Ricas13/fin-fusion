'use strict';

const v2=require('./customer-360-view-v2');
const manage=require('./admin-customer-management');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}

function stremioAccessPanel(detail){
  const entitlement=detail.primaryEntitlement||detail.subscriptions?.[0]||{},name=entitlement.name||entitlement.plan_name||entitlement.plan_name_snapshot||'Stremio access';
  return `<section class="section"><div class="sectionHead"><div><h2>Stremio access</h2><div class="muted">This customer has a Stremio-only primary plan, so Jellyfin customer policy, library and server-placement overrides do not apply here.</div></div><span class="pill good">${String(entitlement.status||'active')==='past_due'?'Payment attention':'Included'}</span></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Current delivery</h2></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Plan</div><div class="kvValue">${escapeHtml(name)}</div></div><div class="kvRow"><div class="kvLabel">Service</div><div class="kvValue">Stremio</div></div><div class="kvRow"><div class="kvLabel">Customer Jellyfin account</div><div class="kvValue">Not required</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Manage Stremio</h2></div><div class="profileCardBody"><p class="subText">Source connections, library indexing and Stremio runtime are managed in the Stremio control centre. Customer-specific service reconciliation remains available from this customer's Manage tab.</p><a class="button secondary" href="/admin/servers/stremio">Open Stremio control centre</a></div></section></div></section>`;
}
function jellyfinPasswordSupport(detail){
  const customerId=detail?.customer?.id,accounts=(detail?.accounts||[]).filter(account=>!account.disabled&&String(account.account_purpose||'jellyfin')!=='stremio_internal');
  if(!customerId||!accounts.length)return'';
  return `<section class="section"><div class="sectionHead"><div><h2>Jellyfin password support</h2><div class="muted">Help this customer change a Jellyfin password without exposing or storing the plaintext password in CAPTAiNFiN.</div></div><a class="button secondary" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}">Change Jellyfin password</a></div></section>`;
}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function foldedAccessSections(detail,token,options){
  const portal=manage.portalSection(detail,token,options.activationInfo);
  const stremioInstall=options.stremioInfo?manage.stremioSection(detail,token,options.stremioInfo):'';
  return portal+stremioInstall;
}
function body(detail,tab,token,accessDetail,options={}){
  const safe=customerFacingDetail(detail),type=serviceType(detail);
  if(tab==='access'&&type==='stremio')return v2.body(safe,tab,token,accessDetail,{skipAccessSections:true})+stremioAccessPanel(detail)+foldedAccessSections(safe,token,options);
  const html=v2.body(safe,tab,token,accessDetail);
  if(tab!=='access')return html;
  return jellyfinPasswordSupport(safe)+html+foldedAccessSections(safe,token,options);
}

module.exports={...v2,body,serviceType,customerFacingDetail,jellyfinPasswordSupport,activeSubscription};