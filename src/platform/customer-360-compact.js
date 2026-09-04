'use strict';

const {query}=require('../db');
const requestUsers=require('../integrations/request-user-sync');
const accessCards=require('./customer-360-access-cards');
const {esc}=require('./admin-html');

function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function dt(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function money(minor,currency='GBP'){const raw=String(currency||'GBP').toUpperCase(),code=/^[A-Z]{3}$/.test(raw)?raw:'GBP';return new Intl.NumberFormat('en-GB',{style:'currency',currency:code,currencyDisplay:'narrowSymbol'}).format(Number(minor||0)/100);}
function pill(text,tone=''){return `<span class="pill ${tone}">${esc(text)}</span>`;}
function buttonForm(token,action,label,{tone='secondary',fields={}}={}){return `<form class="plainForm" method="post" action="${esc(action)}" data-native-submit="true">${csrfHidden(token)}${Object.entries(fields).map(([name,value])=>`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join('')}<button class="button ${esc(tone)} sm" type="submit">${esc(label)}</button></form>`;}
function bulkForm(token,customerId,action,label,tone='secondary'){return `<form class="plainForm" method="post" action="/admin/customers/bulk/preview">${csrfHidden(token)}<input type="hidden" name="customerId" value="${esc(customerId)}"><input type="hidden" name="action" value="${esc(action)}"><button class="button ${esc(tone)} sm" type="submit">${esc(label)}</button></form>`;}
function stateRow(label,value){return `<div class="opState"><span>${esc(label)}</span><strong>${value}</strong></div>`;}
function card(title,status,body,actions='',extraClass=''){return `<section class="opCard ${esc(extraClass)}"><div class="opCardHead"><h2>${esc(title)}</h2>${status||''}</div><div class="opCardBody">${body}</div>${actions?`<div class="opActions">${actions}</div>`:''}</section>`;}
function disclosure(title,summary,body){return `<details class="opDisclosure"><summary><span>${esc(title)}</span><small>${esc(summary||'')}</small><span class="opChevron">▸</span></summary><div class="opDisclosureBody">${body}</div></details>`;}
function readableAction(value){return String(value||'Activity').replace(/^admin\./,'').replace(/^customer\./,'').replace(/^billing\./,'').replaceAll('.',' · ').replaceAll('_',' ');}
function currentSubscriptions(detail){return (detail.subscriptions||[]).filter(s=>['active','trialing','past_due','paused'].includes(String(s.status||''))&&(!s.current_period_end||new Date(s.current_period_end)>new Date()));}
function recurring(sub){const ref=String(sub?.provider_subscription_id||'');return (sub?.source==='stripe'&&/^sub_/i.test(ref))||(sub?.source==='paypal'&&/^I-/i.test(ref));}

async function supplementary(customerId){
  const [media,request,payments,discord,plans,override]=await Promise.all([
    query(`SELECT ja.id,ja.jellyfin_username,ja.disabled,ja.is_primary,ja.password_setup_required,ja.password_reset_required,js.id server_id,js.name server_name,js.health_status,COALESCE(js.media_server_type,'jellyfin') media_server_type FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose<>'stremio_internal' ORDER BY CASE COALESCE(js.media_server_type,'jellyfin') WHEN 'jellyfin' THEN 0 ELSE 1 END,ja.is_primary DESC,ja.created_at`,[customerId]).catch(()=>({rows:[]})),
    requestUsers.requestAccessForCustomer(customerId).catch(()=>null),
    query(`SELECT provider,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor FROM payment_history_transactions WHERE customer_id=$1 ORDER BY occurred_at DESC LIMIT 75`,[customerId]).catch(()=>({rows:[]})),
    query(`SELECT COALESCE(cp.discord_user_id,c.discord_user_id) discord_user_id,c.discord_username FROM customers c LEFT JOIN customer_communication_preferences cp ON cp.customer_id=c.id WHERE c.id=$1`,[customerId]).catch(()=>({rows:[]})),
    query(`SELECT id,name,duration_days,price_minor,currency,billing_interval FROM plans WHERE active=TRUE AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) AND audience IN('direct','both') AND COALESCE(is_addon,FALSE)=FALSE AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio') ORDER BY sort_order,price_minor,name`).catch(()=>({rows:[]})),
    query(`SELECT o.subscription_id,o.reason,COALESCE(s.plan_name_snapshot,p.name) plan_name FROM customer_entitlement_overrides o JOIN subscriptions s ON s.id=o.subscription_id JOIN plans p ON p.id=s.plan_id WHERE o.customer_id=$1 AND o.permanent_access=TRUE AND o.revoked_at IS NULL LIMIT 1`,[customerId]).catch(()=>({rows:[]}))
  ]);
  return{media:media.rows,request,payments:payments.rows,discord:discord.rows[0]||null,plans:plans.rows,override:override.rows[0]||null};
}

function portalEnrolForm(c,token){return `<details class="opInlineDetails"><summary>Enrol portal account…</summary><form class="opInlineForm" method="post" action="/admin/users/${encodeURIComponent(c.id)}/manage/portal/enrol" data-native-submit="true">${csrfHidden(token)}<label>Username<input class="input" name="username" minlength="3" maxlength="40" required value="${esc(c.display_name||'')}"></label><label>Email<input class="input" type="email" name="email" maxlength="254" required value="${esc(c.email||'')}"></label><small>Creates a disabled portal login and a recoverable onboarding link. The customer chooses the password.</small><button class="button primary sm">Enrol & create onboarding link</button></form></details>`;}
function portalCard(detail,token){
  const c=detail.customer,id=c.id,enrolled=Boolean(c.app_user_id),active=Boolean(c.login_active),verified=Boolean(c.email_verified_at);
  const body=`${stateRow('Username',esc(c.login_username||'Not enrolled'))}${stateRow('Email',esc(c.login_email||c.email||'—'))}${stateRow('Account',enrolled?pill(active?'Active':'Disabled',active?'good':'warn'):pill('Not enrolled','warn'))}${stateRow('Verification',pill(verified?'Verified':'Not verified',verified?'good':'warn'))}${enrolled?'':portalEnrolForm(c,token)}`;
  const actions=[`<a class="button secondary sm" href="/admin/users/${encodeURIComponent(id)}/edit-profile">Edit account</a>`];
  if(enrolled){actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/activation/rotate`,'Reset / onboarding link'));actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/email/${verified?'unverify':'verify'}`,verified?'Mark unverified':'Mark verified'));actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/portal/status`,active?'Disable portal':'Enable portal',{tone:active?'secondary':'primary',fields:{active:active?'0':'1'}}));}
  return card('Customer / Portal',enrolled?pill(active?'Active':'Disabled',active?'good':'warn'):pill('Not enrolled','warn'),body,actions.join(''));
}

function manualGrantForm(detail,token,plans){
  if(!plans.length)return '<div class="opEmpty">No grantable direct-customer plans are active.</div>';
  const start=new Date(),first=plans[0],end=new Date(start);end.setUTCDate(end.getUTCDate()+Number(first.duration_days||30));
  const options=plans.map(p=>`<option value="${esc(p.id)}" data-days="${esc(p.duration_days||30)}" data-amount="${esc((Number(p.price_minor||0)/100).toFixed(2))}" data-currency="${esc(p.currency||'GBP')}">${esc(p.name)}</option>`).join('');
  return `<details class="opInlineDetails"><summary>Add plan manually…</summary><form class="opInlineForm manualGrantCompact" method="post" action="/admin/users/${encodeURIComponent(detail.customer.id)}/manual-grant" data-native-submit="true">${csrfHidden(token)}<input type="hidden" name="returnTab" value="access"><label>Plan<select class="input" name="planId" id="manualGrantPlan" required>${options}</select></label><div class="opInlinePair"><label>Start<input class="input" type="date" name="startDate" id="manualGrantStart" value="${esc(start.toISOString().slice(0,10))}" required></label><label>End<input class="input" type="date" name="endDate" id="manualGrantEnd" value="${esc(end.toISOString().slice(0,10))}" required></label></div><div class="opInlinePair"><label>Amount<input class="input" name="amount" id="manualGrantAmount" value="${esc((Number(first.price_minor||0)/100).toFixed(2))}" required></label><label>Currency<select class="input" name="currency" id="manualGrantCurrency"><option>GBP</option><option>USD</option><option>EUR</option></select></label></div><label>Method<select class="input" name="method"><option value="other">Other / complimentary</option><option value="bank">Bank transfer</option><option value="paypal">PayPal</option><option value="stripe">Stripe</option></select></label><label>Note<input class="input" name="note" maxlength="500" placeholder="Why this access is being granted"></label><label class="opConfirm"><input type="checkbox" name="confirm" value="1" required> I understand this creates local access and does not charge a provider.</label><button class="button primary sm">Grant plan</button></form><script src="/js/admin-manual-entitlement.js" defer></script></details>`;}
function plansCard(detail,token,plans){
  const id=detail.customer.id,subs=detail.subscriptions||[],current=currentSubscriptions(detail);
  const body=`${subs.length?subs.slice(0,6).map(sub=>`<div class="opItem"><div><strong>${esc(sub.plan_name||sub.plan_code||'Plan')}</strong><span>${esc(sub.source||'local')}${sub.current_period_end?` · ${esc(dt(sub.current_period_end))}`:''}</span></div>${pill(String(sub.status||'unknown').replaceAll('_',' '),['active','trialing'].includes(sub.status)?'good':sub.status==='past_due'?'warn':'')}</div>`).join(''):'<div class="opEmpty">No subscription records.</div>'}${current.length?'':manualGrantForm(detail,token,plans)}`;
  const actions=[];
  if(current.length){
    actions.push(bulkForm(token,id,'plan_change','Change plan'));actions.push(bulkForm(token,id,'extend_entitlement','Extend'));actions.push(bulkForm(token,id,'set_expiry','Edit expiry'));
    const primary=current.find(s=>String(s.id)===String(detail.primaryEntitlement?.subscription_id))||current[0];
    if(recurring(primary))actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/renewal`,primary.cancel_at_period_end?'Resume renewal':'Stop renewal',{fields:{enabled:primary.cancel_at_period_end?'1':'0'}}));
    if(current.some(s=>['jellyfin','bundle'].includes(String(s.service_type||'jellyfin'))))actions.push(bulkForm(token,id,'end_jellyfin_plan','Revoke current plan now','danger'));
  }
  return card('Plans & Subscriptions',pill(`${current.length} active`,current.length?'good':''),body,actions.join(''));
}

function mediaCard(detail,token,media){
  const id=detail.customer.id,jellyfin=media.filter(a=>a.media_server_type!=='emby'),emby=media.filter(a=>a.media_server_type==='emby');
  const body=`${media.length?media.map(account=>`<div class="opItem"><div><strong>${esc(account.media_server_type==='emby'?'Emby':'Jellyfin')} · ${esc(account.jellyfin_username)}</strong><span>${esc(account.server_name||'Server')} · ${esc(account.disabled?'disabled':account.health_status||'active')}</span></div>${pill(account.disabled?'Disabled':'Enabled',account.disabled?'warn':'good')}</div>`).join(''):'<div class="opEmpty">No Jellyfin / Emby account.</div>'}`;
  const actions=[];
  if(media.length){if(jellyfin.length)actions.push(`<a class="button secondary sm" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(id)}">Reset Jellyfin password</a>`);if(jellyfin.length)actions.push(bulkForm(token,id,'migrate_server','Move Jellyfin server'));actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Reconcile'));}
  else actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Create / provision',{tone:'primary'}));
  if(emby.length&&!jellyfin.length)actions.push('<span class="opActionNote">Emby-specific destructive/credential actions are not exposed unless backed by a safe service lifecycle route.</span>');
  return card('Jellyfin / Emby',pill(`${media.filter(a=>!a.disabled).length}/${media.length} enabled`,media.some(a=>!a.disabled)?'good':''),body,actions.join(''));
}

function stremioCard(detail,token,state){
  const id=detail.customer.id,row=state?.row||null,status=String(row?.status||'not provisioned').replaceAll('_',' ');
  const body=`${stateRow('Entitlement',row?pill(status,row.status==='active'?'good':'warn'):pill('Not provisioned','warn'))}${stateRow('Install access',esc(state?.manifestUrl?'Available':row?.status==='active'?'Rotate to recover':'Not issued'))}`;
  const actions=[buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/stremio/install`,state?.recovered?'Rotate credentials':'Provision / re-provision')];
  if(row&&row.status!=='revoked')actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/stremio/revoke`,'Revoke install'));
  if(row)actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/stremio-household/reset`,'Reset household/IP'));
  actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Reconcile'));
  return card('Stremio',row?pill(status,row.status==='active'?'good':'warn'):pill('Not provisioned','warn'),body,actions.join(''));
}

function overseerrCard(detail,token,request){
  const id=detail.customer.id,status=request?.status||'not provisioned',linked=Boolean(request?.external_user_id),eligible=Boolean(request?.entitlement_active);
  const body=`${stateRow('Account',linked?esc(request.external_username||request.external_email||'Linked'):'Not created')}${stateRow('Access',pill(eligible&&!request?.access_suspended?'Enabled':'Not active',eligible&&!request?.access_suspended?'good':'warn'))}${request?.last_error?stateRow('Problem',esc(String(request.last_error).slice(0,120))):''}`;
  const actions=[buttonForm(token,`/admin/request-users/${encodeURIComponent(id)}/sync`,linked?'Re-provision / resync':'Create / provision')];
  if(linked)actions.push(`<a class="button secondary sm" href="/admin/request-users">Open request-service manager</a>`);
  return card('Overseerr',pill(status,status==='synced'?'good':status==='failed'?'bad':'warn'),body,actions.join(''));
}

function discordCard(detail,token,discord){
  const id=detail.customer.id,linked=Boolean(discord?.discord_user_id||detail.customer.discord_user_id),name=discord?.discord_username||detail.customer.discord_username;
  const body=`${stateRow('Link',pill(linked?'Linked':'Not linked',linked?'good':'warn'))}${stateRow('Member',esc(name||'—'))}${stateRow('Role source','Current active plans')}`;
  const actions=[`<a class="button secondary sm" href="/admin/users/${encodeURIComponent(id)}/edit-profile">${linked?'Edit Discord link':'Link Discord'}</a>`,buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Sync roles / reconcile')];
  return card('Discord',pill(linked?'Linked':'Not linked',linked?'good':'warn'),body,actions.join(''));
}

function holdsCard(detail,token){
  const id=detail.customer.id,holds=detail.activeHolds||[];
  const body=holds.length?holds.map(hold=>`<div class="opHold"><div><strong>${esc(String(hold.hold_type||'hold').replaceAll('_',' '))}</strong><span>${esc(hold.reason||'Access restricted')}</span></div>${String(hold.hold_type)==='payment_risk'?pill('Payment workflow','warn'):`<details class="miniMenu"><summary>Release…</summary><form method="post" action="/admin/users/${encodeURIComponent(id)}/access-holds/${encodeURIComponent(hold.id)}/release">${csrfHidden(token)}<input class="input" name="reason" minlength="5" maxlength="500" placeholder="Release reason" required><input class="input" name="confirmation" placeholder="Type RELEASE" required><button class="button secondary sm">Release hold</button></form></details>`}</div>`).join(''):'<div class="opEmpty">No active holds or suspensions.</div>';
  const actions=[bulkForm(token,id,'suspend','Add suspension'),buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Reconcile access')];
  return card('Access / Holds',pill(holds.length?`${holds.length} active`:'Clear',holds.length?'warn':'good'),body,actions.join(''));
}

function overrideCard(detail,token,override){
  const id=detail.customer.id,holds=detail.activeHolds||[],subs=(detail.subscriptions||[]).filter(sub=>!sub.is_addon&&!sub.superseded_by).slice(0,12),active=Boolean(override?.subscription_id);
  const preferred=String(override?.subscription_id||detail.primaryEntitlement?.subscription_id||subs[0]?.id||'');
  const options=subs.map(sub=>`<option value="${esc(sub.id)}" ${String(sub.id)===preferred?'selected':''}>${esc(sub.plan_name||sub.plan_code||'Plan')} · ${esc(String(sub.status||'unknown').replaceAll('_',' '))}${sub.current_period_end?` · ${esc(dt(sub.current_period_end))}`:''}</option>`).join('');
  const body=`${stateRow('Automation',active?pill('OVERRIDDEN','bad'):pill('Normal','good'))}${stateRow('Active blockers',pill(String(holds.length),holds.length?'warn':'good'))}${active?stateRow('Pinned plan',esc(override.plan_name||'Selected subscription')):''}<p class="opHint">Break glass ignores normal hold ownership. Force Access ON pins the selected primary subscription as authoritative access and clears every active hold. Provider billing is not changed.</p>${options?`<form class="opInlineForm" method="post" action="/admin/users/${encodeURIComponent(id)}/manage/force/access-on" data-native-submit="true">${csrfHidden(token)}<label>Plan / subscription to force<select class="input" name="subscriptionId" required>${options}</select></label><button class="button danger sm" type="submit">FORCE ACCESS ON</button></form>`:'<div class="opEmpty">No primary subscription exists to pin. Add a plan manually first.</div>'}`;
  const actions=[buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/force/clear-blockers`,'CLEAR ALL BLOCKERS',{tone:'danger'}),buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'FORCE RECONCILE')];
  if(active)actions.push(buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/force/automation`,'Return to automation',{tone:'primary'}));
  return card('Admin Override',active?pill('BREAK GLASS ACTIVE','bad'):pill('Break glass','warn'),body,actions.join(''),'danger');
}

function dangerCard(detail,token,media,state){
  const id=detail.customer.id,actions=[],jellyfin=media.filter(a=>a.media_server_type!=='emby'),emby=media.filter(a=>a.media_server_type==='emby');
  if(jellyfin.length)actions.push(`<details class="dangerAction"><summary>Delete Jellyfin account(s)…</summary><p>Deletes customer Jellyfin account(s). It does not delete the portal customer, Emby account, payment history or unrelated service entitlements.</p>${bulkForm(token,id,'jellyfin_delete','Review Jellyfin deletion','danger')}</details>`);
  if(state?.row&&state.row.status!=='revoked')actions.push(`<details class="dangerAction"><summary>Revoke Stremio installation…</summary><p>Invalidates the current Stremio installation credential. It does not delete the portal customer or payment history.</p>${buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/stremio/revoke`,'Revoke Stremio install','danger')}</details>`);
  actions.push(`<details class="dangerAction"><summary>Delete customer completely…</summary><p>Permanent customer deletion uses the existing guarded deletion saga and requires typed confirmation before execution.</p>${bulkForm(token,id,'portal_delete','Review permanent deletion','danger')}</details>`);
  if(emby.length)actions.push('<div class="dangerNote">Emby deletion is not exposed here because no independent, audited Emby account-deletion lifecycle was found.</div>');
  actions.push('<div class="dangerNote">Deleting an individual subscription record is not exposed until Fin-Fusion can prove provider, entitlement and history references can be removed without corrupting the customer record. Use immediate revoke for normal access removal.</div>');
  actions.push('<div class="dangerNote">Overseerr account deletion is not exposed because the existing canonical request-service lifecycle suspends/resyncs accounts to preserve request history rather than deleting them.</div>');
  return card('Danger Zone',pill('Destructive','bad'),'<p class="opHint">Destructive corrections only. Normal cancellations and service revocation belong in the cards above.</p>',actions.join(''),'danger');
}

function activityDisclosure(detail){const rows=(detail.timeline||[]).slice(0,75);const body=rows.length?`<div class="opTimeline">${rows.map(row=>`<div class="opTimelineRow"><time>${esc(dt(row.at))}</time><div><strong>${esc(readableAction(row.title))}</strong>${row.detail?`<span>${esc(readableAction(row.detail))}</span>`:''}</div></div>`).join('')}</div>`:'<div class="opEmpty">No meaningful activity recorded yet.</div>';return disclosure('Activity',`${rows.length} recent events`,body);}
function paymentsDisclosure(rows){const body=rows.length?`<div class="compactTable"><div class="compactTableHead"><span>Date</span><span>Provider</span><span>Type</span><span>Amount</span><span>Status</span></div>${rows.map(row=>{const amount=esc(money(row.gross_amount_minor,row.currency));return `<div class="compactTableRow"><span>${esc(dt(row.occurred_at))}</span><span>${esc(row.provider||'—')}</span><span>${esc(String(row.transaction_type||'payment').replaceAll('_',' '))}</span><span>${amount}</span><span>${esc(row.transaction_status||'—')}</span></div>`;}).join('')}</div>`:'<div class="opEmpty">No payment history recorded.</div>';return disclosure('Payments',`${rows.length} payment / refund events`,body);}
function logsDisclosure(detail){const runs=(detail.runs||[]).slice(0,50),state=detail.provisioningState;const body=`${state?.last_error?`<div class="notice error">${esc(state.last_error)}</div>`:''}${runs.length?`<div class="compactTable"><div class="compactTableHead log"><span>When</span><span>Action</span><span>Status</span><span>Completed</span></div>${runs.map(run=>`<div class="compactTableRow log"><span>${esc(dt(run.started_at))}</span><span>${esc(run.action)}</span><span>${esc(run.status)}</span><span>${esc(dt(run.completed_at))}</span></div>`).join('')}</div>`:'<div class="opEmpty">No provisioning / reconciliation logs yet.</div>'}`;return disclosure('Logs',`${runs.length} operational events`,body);}

function styles(){return `<style>
.customer360Core{display:grid;gap:12px}.opGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:start}.opCard{border:1px solid var(--border,#29333d);border-radius:10px;background:rgba(255,255,255,.014);padding:11px;min-width:0}.opCardHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.opCardHead h2{font-size:.86rem;margin:0}.opCardBody{display:grid;gap:4px}.opState{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:3px 0;font-size:.72rem}.opState>span:first-child{color:var(--muted)}.opState strong{font-weight:700;text-align:right;overflow-wrap:anywhere}.opItem,.opHold{display:flex;justify-content:space-between;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--border-soft,var(--border))}.opItem:last-child,.opHold:last-child{border-bottom:0}.opItem>div,.opHold>div{min-width:0}.opItem strong,.opHold strong{display:block;font-size:.74rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.opItem span,.opHold span{display:block;color:var(--muted);font-size:.65rem;margin-top:2px}.opActions{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px}.opActions .button{min-height:26px;padding:4px 7px;font-size:.65rem}.opActionNote{font-size:.62rem;color:var(--muted);align-self:center}.opEmpty,.opHint,.dangerNote{font-size:.68rem;color:var(--muted);line-height:1.4}.danger{border-color:color-mix(in srgb,var(--danger,#e16c72) 42%,var(--border))}.dangerAction,.miniMenu,.opInlineDetails{margin-top:6px;border-top:1px solid var(--border);padding-top:6px}.dangerAction>summary,.miniMenu>summary,.opInlineDetails>summary{cursor:pointer;font-size:.69rem;font-weight:750;list-style:none}.dangerAction>summary::-webkit-details-marker,.miniMenu>summary::-webkit-details-marker,.opInlineDetails>summary::-webkit-details-marker{display:none}.dangerAction p{font-size:.65rem;color:var(--muted);margin:5px 0 7px}.miniMenu form,.opInlineForm{display:grid;gap:6px;margin-top:7px}.opInlineForm label{display:grid;gap:3px;font-size:.64rem;color:var(--muted)}.opInlineForm .input,.miniMenu .input{min-height:28px;padding:4px 6px;font-size:.66rem}.opInlinePair{display:grid;grid-template-columns:1fr 1fr;gap:6px}.opConfirm{display:flex!important;grid-template-columns:auto 1fr!important;align-items:flex-start;gap:6px!important}.opInlineForm small{color:var(--muted);font-size:.61rem}.opNested{margin-top:7px}.opNested>.section{margin:0;padding:0;border:0;background:transparent}.opNested>.section>.sectionHead{display:none}.opNested>.section>.sectionBody{padding:0}.opDisclosure{border-top:1px solid var(--border);opacity:.88}.opDisclosure>summary{display:flex;align-items:center;gap:10px;padding:11px 3px;cursor:pointer;list-style:none;font-size:.76rem;font-weight:800}.opDisclosure>summary::-webkit-details-marker{display:none}.opDisclosure>summary small{margin-left:auto;color:var(--muted);font-weight:500}.opChevron{color:var(--muted);transition:transform .12s ease}.opDisclosure[open] .opChevron{transform:rotate(90deg)}.opDisclosureBody{padding:0 0 12px}.opTimeline{display:grid;gap:1px}.opTimelineRow{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px;padding:6px 8px;border-bottom:1px solid var(--border);font-size:.69rem}.opTimelineRow time{color:var(--muted)}.opTimelineRow strong{display:block}.opTimelineRow span{display:block;color:var(--muted);margin-top:2px}.compactTable{font-size:.68rem}.compactTableHead,.compactTableRow{display:grid;grid-template-columns:1.25fr .8fr 1fr .7fr .7fr;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border)}.compactTableHead{font-weight:750;color:var(--muted)}.compactTableHead.log,.compactTableRow.log{grid-template-columns:1.2fr 1.4fr .7fr 1.2fr}.customer360Core~.section{display:none!important}@media(max-width:1499px){.opGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:920px){.opGrid{grid-template-columns:1fr}}@media(max-width:620px){.opTimelineRow{grid-template-columns:1fr}.compactTableHead{display:none}.compactTableRow,.compactTableRow.log{grid-template-columns:1fr 1fr}.opInlinePair{grid-template-columns:1fr}}
</style>`;}

async function render(detail,token,options={}){
  if(!detail?.customer?.id)return'';
  const extra=await supplementary(detail.customer.id);
  // Lane-aware "Permissions, libraries & requests…" remain available through the compact Jellyfin & Overseerr settings disclosure below.
  const accessHtml=await accessCards.accessLibrariesRequests(detail,token,options).catch(()=> '');
  const hasJellyfinPlan=currentSubscriptions(detail).some(sub=>['jellyfin','bundle'].includes(String(sub.service_type_snapshot||sub.service_type||'jellyfin').toLowerCase()));
  const planSettings=hasJellyfinPlan&&accessHtml?disclosure('Jellyfin & Overseerr settings','Library access · Jellyfin user settings · request access',`<div class="opNested">${accessHtml}</div>`):'';
  const cards=[portalCard(detail,token),plansCard(detail,token,extra.plans),mediaCard(detail,token,extra.media),stremioCard(detail,token,options.stremioInfo),overseerrCard(detail,token,extra.request),discordCard(detail,token,extra.discord),holdsCard(detail,token),overrideCard(detail,token,extra.override),dangerCard(detail,token,extra.media,options.stremioInfo)];
  const core=`<div class="customer360Core" data-customer360-core><div class="opGrid">${cards.join('')}</div>${planSettings}${activityDisclosure(detail)}${paymentsDisclosure(extra.payments)}${logsDisclosure(detail)}</div>`;
  return `${accessCards.styles()}${styles()}${core}`;
}

module.exports={render,supplementary,portalCard,plansCard,mediaCard,stremioCard,overseerrCard,discordCard,holdsCard,overrideCard,dangerCard,activityDisclosure,paymentsDisclosure,logsDisclosure,styles};