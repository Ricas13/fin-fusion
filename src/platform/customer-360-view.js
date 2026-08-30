'use strict';

const v2=require('./customer-360-view-v2');
const manage=require('./admin-customer-management');

function serviceType(detail){return String(detail?.primaryEntitlement?.service_type_snapshot||detail?.primaryEntitlement?.service_type||detail?.subscriptions?.[0]?.service_type||'jellyfin');}
function customerFacingDetail(detail){return{...detail,accounts:(detail.accounts||[]).filter(account=>String(account.account_purpose||'jellyfin')!=='stremio_internal')};}
function activeSubscription(detail){return (detail.subscriptions||[]).find(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()))||detail.subscriptions?.[0]||null;}
function escapeHtml(value){return String(value==null?'':value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;}
function bulkPreviewForm(token,customerId,action,label,tone='secondary'){return `<form class="plainForm" method="post" action="/admin/customers/bulk/preview" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="customerId" value="${escapeHtml(customerId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button class="button ${escapeHtml(tone)}" type="submit">${escapeHtml(label)}</button></form>`;}
function reconcileForm(token,customerId,label='Reconcile access',tone='secondary'){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/reconcile" data-native-submit="true">${csrfHidden(token)}<button class="button ${escapeHtml(tone)}" type="submit">${escapeHtml(label)}</button></form>`;}
function reenableJellyfinForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/jellyfin/re-enable" data-native-submit="true">${csrfHidden(token)}<button class="button primary" type="submit">Re-enable Jellyfin access</button></form>`;}
function serverPlacementResetForm(token,customerId){return `<details class="compactAction"><summary class="button secondary">Use plan placement…</summary><form class="formPanel compactAction" method="post" action="/admin/users/${encodeURIComponent(customerId)}/server-placement/reset" data-native-submit="true">${csrfHidden(token)}<div class="inlineHelp">Re-evaluates the plan's automatic placement. If another server is selected, CAPTAiNFiN uses the guarded move workflow and the customer must set their Jellyfin password again.</div><div class="formGroup"><label>Type <strong>PLACE</strong> to confirm</label><input class="input" name="confirmation" autocomplete="off" placeholder="PLACE" required></div><button class="button secondary" type="submit">Apply plan placement</button></form></details>`;}
function expiryResetForm(token,customerId){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/expiry/reset" data-native-submit="true">${csrfHidden(token)}<button class="button secondary" type="submit">Reset expiry to plan term</button></form>`;}
function permanentForm(token,customerId,active){return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/permanent-access" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="action" value="${active?'revoke':'enable'}"><input type="hidden" name="reason" value="${escapeHtml(active?'Permanent access removed from Customer 360 Access':'Permanent access granted from Customer 360 Access')}"><button class="button secondary" type="submit">${active?'Reset expiry to subscription':'Make permanent'}</button></form>`;}
function fmtDate(value){if(!value)return'—';if(value===Infinity||String(value).toLowerCase()==='infinity')return'Never';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function isRecurring(sub){const ref=String(sub?.provider_subscription_id||'');return (sub?.source==='stripe'&&/^sub_/i.test(ref))||(sub?.source==='paypal'&&/^I-/i.test(ref));}
function isPermanent(plan){return plan?.access_expires_at===Infinity||String(plan?.access_expires_at||'').toLowerCase()==='infinity';}
function serviceIncludesJellyfin(plan,detail){const type=String(plan?.service_type_snapshot||plan?.service_type||serviceType(detail)).toLowerCase();return type==='jellyfin'||type==='bundle';}
function planTerm(plan){if(!plan)return'—';if(plan.is_free_tier)return'Free Access · no normal expiry';const interval=String(plan.billing_interval_snapshot||plan.billing_interval||'').replaceAll('_',' ');if(interval)return interval;const days=Number(plan.duration_days_snapshot||plan.duration_days||0);return days?`${days} days`:'Plan-controlled';}
function accessWorkspaceSection(detail,token,accessDetail){
  const customerId=detail?.customer?.id;if(!customerId)return'';
  const plan=accessDetail?.currentPlan||detail.primaryEntitlement||activeSubscription(detail),sub=activeSubscription(detail),permanent=isPermanent(plan),includesJellyfin=serviceIncludesJellyfin(plan,detail),allAccounts=(detail.accounts||[]).filter(a=>String(a.account_purpose||'jellyfin')!=='stremio_internal'),accounts=allAccounts.filter(a=>!a.disabled),disabledAccounts=allAccounts.filter(a=>a.disabled),freePlan=Boolean(plan?.is_free_tier||sub?.is_free_tier);
  const planName=plan?.name||plan?.plan_name||plan?.plan_name_snapshot||sub?.plan_name||sub?.plan_code||'No active plan';
  const planService=String(plan?.service_type_snapshot||plan?.service_type||sub?.service_type||'jellyfin');
  const serverCurrent=allAccounts.length?allAccounts.map(a=>`${a.server_name||'Assigned server'}${a.disabled?' · disabled':''}`).join(', '):'Not assigned';
  const serverDefault=plan?.server_class?`${plan.server_class} · automatic placement`:'No Jellyfin server class';
  const expiryCurrent=permanent?'Never · customer override':fmtDate(sub?.current_period_end||plan?.current_period_end);
  const expiryDefault=isRecurring(sub)?'Provider billing period':planTerm(plan);
  const lastRecon=allAccounts.map(a=>a.recon_status).filter(Boolean)[0]||'Not reconciled yet',lastError=allAccounts.map(a=>a.recon_last_error).find(Boolean)||'';
  const planActions=bulkPreviewForm(token,customerId,'plan_change','Manual entitlement edit','primary');
  const canReenable=includesJellyfin&&freePlan&&disabledAccounts.length>0&&accounts.length===0;
  const serverActions=includesJellyfin?(canReenable?`${reenableJellyfinForm(token,customerId)}${reconcileForm(token,customerId)}`:accounts.length?`${bulkPreviewForm(token,customerId,'migrate_server','Move server')}${serverPlacementResetForm(token,customerId)}`:reconcileForm(token,customerId,'Provision / reconcile access')):'';
  let expiryActions='';
  if(permanent)expiryActions=permanentForm(token,customerId,true);
  else if(isRecurring(sub))expiryActions=`<a class="button secondary" href="/admin/users/${encodeURIComponent(customerId)}?tab=billing">Manage renewal in Billing</a>${permanentForm(token,customerId,false)}`;
  else expiryActions=`${bulkPreviewForm(token,customerId,'set_expiry','Change expiry')}${expiryResetForm(token,customerId)}${permanentForm(token,customerId,false)}`;
  const serverRow=includesJellyfin?`<tr><td data-label="Field">Assigned Jellyfin server</td><td data-label="Plan default">${escapeHtml(serverDefault)}</td><td data-label="Current">${escapeHtml(serverCurrent)}</td><td data-label="Actions"><div class="buttonRow">${serverActions}</div></td></tr>`:'';
  const restoreHelp=canReenable?'<div class="operatorCallout warn"><strong>This Free Server account is disabled.</strong> Re-enable releases only the matching inactivity-policy hold, closes the pending inactivity lifecycle episode and reconciles Jellyfin. Other payment, security or admin holds are preserved. The inactivity clock gets a fresh observation window without inventing playback activity.</div>':'';
  return `<section class="section" id="customer-access-controls"><div class="sectionHead"><div><h2>Access assignment & customer overrides</h2><div class="muted">Plan entitlement and customer-specific overrides are separate operations. Manual entitlement edits never schedule a Stripe/PayPal plan change.</div></div><span class="pill ${lastError?'warn':'good'}">Reconcile: ${escapeHtml(lastRecon)}</span></div>${lastError?`<div class="notice error">${escapeHtml(lastError)}</div>`:''}${restoreHelp}<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Field</th><th>Plan default</th><th>Current</th><th>Actions</th></tr></thead><tbody><tr><td data-label="Field">Plan entitlement</td><td data-label="Plan default">${escapeHtml(planName)} · ${escapeHtml(planService)}</td><td data-label="Current">${escapeHtml(planName)}</td><td data-label="Actions"><div class="buttonRow">${planActions}</div></td></tr>${serverRow}<tr><td data-label="Field">Expiry / permanent access</td><td data-label="Plan default">${escapeHtml(expiryDefault)}</td><td data-label="Current">${escapeHtml(expiryCurrent)}</td><td data-label="Actions"><div class="buttonRow">${expiryActions}</div></td></tr><tr><td data-label="Field">Customer overrides</td><td data-label="Plan default">Plan policy, libraries and household limits</td><td data-label="Current">Customer-specific values shown below</td><td data-label="Actions"><div class="buttonRow">${bulkPreviewForm(token,customerId,'reset_overrides','Reset all to plan')}${reconcileForm(token,customerId,'Reconcile access','primary')}</div></td></tr></tbody></table></div></section>`;
}
function removeGlobalMigrationHop(html,detail,token){const customerId=detail?.customer?.id;if(!customerId)return html;const replacement=bulkPreviewForm(token,customerId,'migrate_server','Move to another server');return String(html||'').replace('<a class="button secondary" href="/admin/provisioning/migrations">Move to another server</a>',replacement);}

function stremioAccessPanel(detail){
  const entitlement=detail.primaryEntitlement||detail.subscriptions?.[0]||{},name=entitlement.name||entitlement.plan_name||entitlement.plan_name_snapshot||'Stremio access';
  return `<section class="section"><div class="sectionHead"><div><h2>Stremio access</h2><div class="muted">This customer has a Stremio-only primary plan, so Jellyfin customer policy, library and server-placement overrides do not apply here.</div></div><span class="pill good">${String(entitlement.status||'active')==='past_due'?'Payment attention':'Included'}</span></div><div class="profileGrid"><section class="profileCard"><div class="profileCardHead"><h2>Current delivery</h2></div><div class="profileCardBody"><div class="kvList"><div class="kvRow"><div class="kvLabel">Plan</div><div class="kvValue">${escapeHtml(name)}</div></div><div class="kvRow"><div class="kvLabel">Service</div><div class="kvValue">Stremio</div></div><div class="kvRow"><div class="kvLabel">Customer Jellyfin account</div><div class="kvValue">Not required</div></div></div></div></section><section class="profileCard"><div class="profileCardHead"><h2>Manage Stremio</h2></div><div class="profileCardBody"><p class="subText">Customer-specific Stremio installation, household limits and reconciliation are managed on this Access tab. Source connections and indexing remain global server settings.</p><a class="button secondary" href="/admin/servers/stremio">Open global Stremio settings</a></div></section></div></section>`;
}
function jellyfinPasswordSupport(detail){
  const customerId=detail?.customer?.id,accounts=(detail?.accounts||[]).filter(account=>!account.disabled&&String(account.account_purpose||'jellyfin')!=='stremio_internal');
  if(!customerId||!accounts.length)return'';
  return `<section class="section"><div class="sectionHead"><div><h2>Jellyfin password support</h2><div class="muted">Help this customer change a Jellyfin password without exposing or storing the plaintext password in CAPTAiNFiN.</div></div><a class="button secondary" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}">Change Jellyfin password</a></div></section>`;
}
function stremioHouseholdSection(detail,token,currentPlan,options){
  const customerId=detail?.customer?.id,planDefault=currentPlan?.stremio_household_network_limit,override=options.householdOverrides?.stremio?.network_limit??null;
  if(!customerId||(planDefault==null&&override==null))return'';
  const hasOverride=override!=null,effective=hasOverride?override:planDefault;
  return `<section class="section"><div class="sectionHead"><h2>Stremio household network</h2><span class="muted">Plan → admin override → effective</span></div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/household-overrides">${csrfHidden(token)}<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Field</th><th>Plan</th><th>Override</th><th>Effective</th><th>Set override</th></tr></thead><tbody><tr><td data-label="Field">Household network limit</td><td data-label="Plan">${planDefault==null?'—':escapeHtml(planDefault)}</td><td data-label="Override">${hasOverride?escapeHtml(override):'—'}</td><td data-label="Effective"><strong>${effective==null?'—':escapeHtml(effective)}</strong></td><td data-label="Set override"><input class="input compact" type="number" name="stremio" aria-label="Household network limit override" min="1" max="10" placeholder="Inherit" value="${hasOverride?escapeHtml(override):''}"></td></tr></tbody></table></div><div class="buttonRow"><button class="button">Save override</button></div></form></section>`;
}
function foldedAccessSections(detail,token,options){
  const portal=manage.portalSection(detail,token,options.activationInfo);
  const stremioInstall=options.stremioInfo?manage.stremioSection(detail,token,options.stremioInfo):'';
  return portal+stremioInstall;
}
function body(detail,tab,token,accessDetail,options={}){
  const safe=customerFacingDetail(detail),type=serviceType(detail);
  if(tab==='access'&&type==='stremio')return v2.body(safe,tab,token,accessDetail,{skipAccessSections:true})+accessWorkspaceSection(safe,token,accessDetail)+stremioAccessPanel(detail)+stremioHouseholdSection(safe,token,accessDetail?.currentPlan,options)+foldedAccessSections(safe,token,options);
  let html=v2.body(safe,tab,token,accessDetail,options);
  if(tab!=='access')return html;
  html=removeGlobalMigrationHop(html,safe,token);
  return jellyfinPasswordSupport(safe)+html+accessWorkspaceSection(safe,token,accessDetail)+foldedAccessSections(safe,token,options);
}

module.exports={...v2,body,serviceType,customerFacingDetail,jellyfinPasswordSupport,activeSubscription,accessWorkspaceSection,reenableJellyfinForm};
