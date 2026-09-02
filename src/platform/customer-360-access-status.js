'use strict';

const {esc}=require('./admin-html');

const LABELS={
  inactivity_policy:'Inactivity policy',
  jellyfin_cleanup:'Dormant-account cleanup',
  payment_risk:'Payment dispute / chargeback review',
  admin_disabled:'Admin disabled',
  admin_suspended:'Admin suspended',
  admin_hold:'Admin access hold',
  legacy:'Legacy admin hold'
};
const RELEASABLE=new Set(['inactivity_policy','jellyfin_cleanup','admin_disabled','admin_suspended','admin_hold','legacy']);

function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function age(value){const when=new Date(value||0).getTime();if(!when)return'Unknown age';const ms=Math.max(0,Date.now()-when),hours=Math.floor(ms/3600000);if(hours<1)return'Less than 1 hour old';if(hours<48)return`${hours} hour${hours===1?'':'s'} old`;const days=Math.floor(hours/24);return`${days} day${days===1?'':'s'} old`;}
function label(hold){return LABELS[String(hold?.hold_type||'')]||String(hold?.hold_type||'Unknown access hold').replaceAll('_',' ');}
function paymentLink(customerId,hold){if(hold.payment_incident_id)return `/admin/commerce?incident=${encodeURIComponent(hold.payment_incident_id)}#incident-${encodeURIComponent(hold.payment_incident_id)}`;return `/admin/commerce?customerId=${encodeURIComponent(customerId)}`;}
function reconcileForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/reconcile" data-native-submit="true">${csrfHidden(token)}<button class="button secondary" type="submit">Reconcile access</button></form>`;}

function releaseControl(token,customerId,hold){
  const type=String(hold?.hold_type||'');
  if(type==='payment_risk')return `<div class="accessCardActions"><a class="button primary" href="${esc(paymentLink(customerId,hold))}">Review payment incident</a></div><div class="inlineHelp">Payment-risk access can only be restored by the payment incident workflow after the live provider state has been re-verified.</div>`;
  if(!RELEASABLE.has(type))return `<div class="inlineHelp">This hold is owned by a specialized workflow and cannot be released from Customer 360.</div>`;
  return `<details class="compactAction"><summary class="button secondary">Review release…</summary><form class="formPanel compactAction" method="post" action="/admin/users/${encodeURIComponent(customerId)}/access-holds/${encodeURIComponent(hold.id)}/release" data-native-submit="true">${csrfHidden(token)}<div class="operatorCallout warn"><strong>Releasing this hold can immediately restore or recreate service access.</strong> The current paid/free entitlement remains intact underneath the hold, so reconciliation may re-enable Jellyfin, request-service access, Stremio-related delivery and Discord roles as applicable.</div><div class="formGroup"><label>Why is this hold safe to release?</label><textarea class="input" name="reason" minlength="5" maxlength="500" required placeholder="Underlying reason has been resolved…"></textarea></div><div class="formGroup"><label>Type <strong>RELEASE</strong> to confirm</label><input class="input" name="confirmation" autocomplete="off" required placeholder="RELEASE"></div><button class="button primary" type="submit">Release hold and reconcile</button></form></details>`;
}

function holdCard(token,customerId,hold){const source=hold.source_key?` · ${hold.source_key}`:'';return `<article class="accessControlCard"><div class="accessControlHead"><div><span class="accessEyebrow">${esc(label(hold))}</span><strong>Access restricted</strong></div><span class="pill warn">Active hold</span></div><div class="accessControlMeta"><span>${esc(age(hold.created_at))}</span><span>${esc(source?`Source${source}`:'No source key')}</span></div><div class="operatorCallout warn"><strong>${esc(hold.reason||'No reason was recorded.')}</strong></div>${releaseControl(token,customerId,hold)}</article>`;}

function render(detail,token){
  const customerId=detail?.customer?.id;if(!customerId)return'';
  const holds=Array.isArray(detail.activeHolds)?detail.activeHolds:[];
  const plan=detail.primaryEntitlement||detail.subscriptions?.[0]||null;
  const planName=plan?.name||plan?.plan_name||plan?.plan_name_snapshot||plan?.plan_code||plan?.contract_plan_name||'No current entitlement';
  const blocked=holds.length>0;
  const summary=blocked
    ? `${holds.length} active access hold${holds.length===1?'':'s'}. The commercial entitlement remains ${plan?`visible as ${planName}`:'separate from these blockers'}.`
    : `No active access holds. ${plan?`${planName} is the current commercial entitlement.`:'No current commercial entitlement was found.'}`;
  return `<section class="section" id="access-status"><div class="sectionHead"><div><h2>Access status</h2><div class="muted">Entitlement and access restrictions are tracked separately so support can see what the customer bought and why delivery is blocked.</div></div><div class="buttonRow"><span class="pill ${blocked?'warn':'good'}">${blocked?'Restricted':'No holds'}</span>${reconcileForm(token,customerId)}</div></div><div class="operatorCallout ${blocked?'warn':'good'}"><strong>${esc(summary)}</strong></div>${holds.length?`<div class="accessControlGrid">${holds.map(hold=>holdCard(token,customerId,hold)).join('')}</div>`:'<div class="emptyCompact">There are no active access holds for this customer.</div>'}</section>`;
}

module.exports={render,reconcileForm,label,RELEASABLE};
