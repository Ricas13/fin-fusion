'use strict';

const v2=require('./customer-360-view-v2');
const ui=require('./admin-ui');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function journey(detail,activeTab='overview'){
  const c=detail.customer||{},sub=activeSubscription(detail),type=serviceType(detail),accounts=(detail.accounts||[]).filter(account=>!account.disabled&&String(account.account_purpose||'jellyfin')!=='stremio_internal');
  const portalOk=c.login_active!==false&&Boolean(c.email_verified_at),accessOk=Boolean(sub)&&(type==='stremio'||accounts.length>0),billingAttention=Boolean(sub&&String(sub.status)==='past_due'),usage=Number(detail.activitySummary?.sessions_30d||0),activeNow=Number(detail.activeStreams?.length||0);
  const problems=[];
  if(c.login_active===false)problems.push({label:'Portal disabled',href:'security',next:'Review portal/security state before troubleshooting service access.'});
  else if(!c.email_verified_at)problems.push({label:'Email not verified',href:'overview',next:'Confirm the customer owns the email address before manually verifying it.'});
  if(!sub)problems.push({label:'No current plan',href:'billing',next:'Assign or restore a plan before reconciling service access.'});
  else if(billingAttention)problems.push({label:'Payment attention',href:'billing',next:'Review the billing state and linked payment incident before changing access.'});
  if(sub&&type!=='stremio'&&!accounts.length)problems.push({label:'Jellyfin not provisioned',href:'access',next:'Create or reconcile Jellyfin access on an eligible server.'});
  const first=problems[0],tone=first?'warn':'streaming';
  const hero=ui.operatorHero({
    tone,
    eyebrow:'Customer journey',
    title:first?first.label:'Customer account is clear',
    body:'Follow the customer in the same order they experience CAPTAiNFiN: account → access → billing → activity. Technical history stays available without leading the workflow.',
    statusLabel:first?'Review needed':'Operating normally',
    next:first?first.next:'No customer intervention is required. Use Activity or History only when investigating a specific question.',
    facts:[
      {label:'Account',value:portalOk?'Ready':c.login_active===false?'Disabled':'Verify email',detail:c.login_username||c.login_email||c.email||'customer portal'},
      {label:'Access',value:accessOk?'Ready':sub?'Needs setup':'No plan',detail:sub?(sub.plan_name||sub.plan_name_snapshot||'current plan'):'no current entitlement'},
      {label:'Billing',value:billingAttention?'Past due':sub?String(sub.status||'unknown'):'—',detail:sub?String(sub.source||'manual'):'no subscription'},
      {label:'Activity',value:activeNow?`${activeNow} live`:`${usage} / 30d`,detail:activeNow?'currently streaming':'playback sessions'}
    ],
    actionsHtml:first?`<a class="button" href="/admin/users/${encodeURIComponent(c.id)}?tab=${encodeURIComponent(first.href)}">Review ${escapeHtml(first.label)}</a><a class="button secondary" href="/admin/users/${encodeURIComponent(c.id)}/manage">Manage customer</a>`:`<a class="button secondary" href="/admin/users/${encodeURIComponent(c.id)}/manage">Manage customer</a><a class="button secondary" href="/admin/users/${encodeURIComponent(c.id)}?tab=activity">View activity</a>`
  });
  const steps=[
    ['overview','1','Account','Identity, verification and safe administrator overrides',portalOk?'Ready':c.login_active===false?'Disabled':'Verify email',portalOk?'good':'warn'],
    ['access','2','Access',type==='stremio'?'Stremio entitlement and household delivery':'Jellyfin account, server and effective policy',accessOk?'Ready':sub?'Needs setup':'No plan',accessOk?'good':'warn'],
    ['billing','3','Billing','Plan history, provider state and payment incidents',billingAttention?'Attention':sub?String(sub.status||'Current'):'No plan',billingAttention?'warn':sub?'good':''],
    ['activity','4','Activity','What the customer is using right now and recently',activeNow?`${activeNow} live`:usage?`${usage} sessions`:'No recent use',activeNow||usage?'good':'']
  ];
  return `${hero}<nav class="customerJourneySteps" aria-label="Customer journey">${steps.map(([tab,n,label,help,status,kind])=>`<a class="quick-action ${activeTab===tab?'current':''}" href="/admin/users/${encodeURIComponent(c.id)}?tab=${tab}"><span class="uiEyebrow">${n}</span><strong>${escapeHtml(label)}</strong><span>${escapeHtml(help)}</span><span class="pill ${kind}">${escapeHtml(status)}</span></a>`).join('')}</nav>`;
}
function stremioAccessPanel(detail){
  const entitlement=detail.primaryEntitlement||detail.subscriptions?.[0]||{},name=entitlement.name||entitlement.plan_name||entitlement.plan_name_snapshot||'Stremio access';
  return `<section class="section"><div class="sectionHead"><div><h2>Stremio access</h2><div class="muted">This customer has a Stremio-only primary plan, so Jellyfin customer policy, library and server-placement overrides do not apply here.</div></div><span class="pill good">${String(entitlement.status||'active')==='past_due'?'Payment attention':'Included'}</span></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Current delivery</h2></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Plan</div><div class="kvValue">${escapeHtml(name)}</div></div><div class="kvRow"><div class="kvLabel">Service</div><div class="kvValue">Stremio</div></div><div class="kvRow"><div class="kvLabel">Customer Jellyfin account</div><div class="kvValue">Not required</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Manage Stremio</h2></div><div class="profileCardBody"><p class="subText">Source connections, library indexing and Stremio runtime are managed in the Stremio control centre. Customer-specific service reconciliation remains available from the Customer Control Centre.</p><a class="button secondary" href="/admin/servers/stremio">Open Stremio control centre</a></div></section></div></section>`;
}
function jellyfinPasswordSupport(detail){
  const customerId=detail?.customer?.id,accounts=(detail?.accounts||[]).filter(account=>!account.disabled&&String(account.account_purpose||'jellyfin')!=='stremio_internal');
  if(!customerId||!accounts.length)return'';
  return `<section class="section"><div class="sectionHead"><div><h2>Jellyfin password support</h2><div class="muted">Help this customer change a Jellyfin password without exposing or storing the plaintext password in CAPTAiNFiN.</div></div><a class="button secondary" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}">Change Jellyfin password</a></div></section>`;
}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function body(detail,tab,token,accessDetail){
  const safe=customerFacingDetail(detail),type=serviceType(detail),html=v2.body(safe,tab,token,accessDetail),journeyHtml=journey(safe,tab);
  if(tab!=='access')return journeyHtml+html;
  if(type!=='stremio')return journeyHtml+jellyfinPasswordSupport(safe)+html;
  const marker='<section class="section"><div class="sectionHead"><h2>Jellyfin access</h2>';
  const at=html.indexOf(marker);
  return journeyHtml+(at<0?html:html.slice(0,at)+stremioAccessPanel(detail));
}

module.exports={...v2,body,serviceType,customerFacingDetail,jellyfinPasswordSupport,journey,activeSubscription};
