'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  const customerMatch=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(path!=='/admin/users'&&!customerMatch)return;

  function ensureStyles(){
    if(document.querySelector('link[href="/css/admin-customer-operator.css"]'))return;
    const link=document.createElement('link');link.rel='stylesheet';link.href='/css/admin-customer-operator.css';document.head.appendChild(link);
  }
  ensureStyles();

  function text(node){return String(node?.textContent||'').trim();}
  function el(tag,className='',value=''){const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined&&value!==null&&value!=='')node.textContent=String(value);return node;}
  function fmtDate(value){if(!value)return'Never';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric'}).format(d);}
  function relativeDate(value){
    if(!value)return'No playback recorded';const time=new Date(value).getTime();if(!Number.isFinite(time))return'No playback recorded';
    const sec=Math.max(0,Math.floor((Date.now()-time)/1000));
    if(sec<60)return'Just now';if(sec<3600)return`${Math.floor(sec/60)}m ago`;if(sec<86400)return`${Math.floor(sec/3600)}h ago`;if(sec<86400*30)return`${Math.floor(sec/86400)}d ago`;return fmtDate(value);
  }
  function money(minor,currency){
    try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP'),currencyDisplay:'narrowSymbol',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(minor||0)/100);}catch(_){return`${currency||''} ${(Number(minor||0)/100).toFixed(2)}`.trim();}
  }
  function paidSummary(metric,freePlan){
    const totals=metric?.payment?.totals||{},entries=Object.entries(totals).filter(([,minor])=>Number(minor)!==0);
    if(!entries.length)return{main:freePlan?'Free':'No recorded payments',sub:freePlan?'No payment required':'No provider payment recorded'};
    const main=entries.map(([currency,minor])=>money(minor,currency)).join(' + ');
    const last=metric?.payment?.lastPayment;
    return{main,sub:last?`Last payment ${money(last.amountMinor,last.currency)} · ${fmtDate(last.at)}`:'Recorded provider total'};
  }
  function usageSummary(metric){
    const active=Number(metric?.activeStreams||0),hours=Number(metric?.watchSeconds30d||0)/3600;
    if(active>0)return{main:`Streaming now · ${active} stream${active===1?'':'s'}`,sub:`${hours.toFixed(hours>=10?0:1)}h watched in 30 days`,live:true};
    return{main:`${hours.toFixed(hours>=10?0:1)}h / 30d`,sub:`Last played ${relativeDate(metric?.lastPlaybackAt)}`,live:false};
  }
  function cellByLabel(row,label){return [...row.children].find(cell=>cell.getAttribute('data-label')===label)||null;}
  function statusBadge(label,tone){const span=el('span',`pill ${tone||''}`,label);return span;}

  async function enhanceCustomerList(){
    const table=document.querySelector('#customersTable');if(!table||table.dataset.operatorFriendly==='1')return;
    table.dataset.operatorFriendly='1';
    const rows=[...table.tBodies[0]?.rows||[]];
    const ids=rows.map(row=>{
      const link=row.querySelector('a[href^="/admin/users/"]');const match=(link?.getAttribute('href')||'').match(/^\/admin\/users\/([0-9a-f-]{36})/i);return match?.[1]||null;
    }).filter(Boolean);
    let metrics={};
    if(ids.length){
      try{const response=await fetch(`/admin/users/operator/metrics?ids=${encodeURIComponent(ids.join(','))}`,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(response.ok){const data=await response.json();metrics=data.customers||{};}}catch(_){metrics={};}
    }

    const head=table.tHead?.rows?.[0];if(head){
      head.replaceChildren();
      ['','Customer','Paid','Usage','Current plan','Access','Server','Registered','Actions'].forEach((label,index)=>{
        const th=el('th','',label);if(index===0){const old=document.querySelector('#checkAllPage');if(old){const clone=old.cloneNode(true);th.replaceChildren(clone);}}head.appendChild(th);
      });
    }

    rows.forEach(row=>{
      const customer=cellByLabel(row,'Customer'),plan=cellByLabel(row,'Plan'),status=cellByLabel(row,'Status'),jellyfin=cellByLabel(row,'Jellyfin'),server=cellByLabel(row,'Server'),registered=cellByLabel(row,'Registered');
      const link=customer?.querySelector('a[href^="/admin/users/"]'),match=(link?.getAttribute('href')||'').match(/^\/admin\/users\/([0-9a-f-]{36})/i),id=match?.[1],metric=metrics[id]||{};
      const accountText=text(jellyfin),accountCount=Number.parseInt(accountText,10)||0,disabled=/disabled/i.test(accountText),planText=text(plan)||'No plan',statusText=text(status).toLowerCase(),freePlan=/free/i.test(planText);
      const paid=paidSummary(metric,freePlan),usage=usageSummary(metric);
      let accessLabel='No plan',accessTone='';
      if(metric.adminMode==='removed'){accessLabel='Removed by admin';accessTone='warn';}
      else if(metric.permanent){accessLabel='Permanent User';accessTone='good';}
      else if(statusText==='none'||/^no plan$/i.test(planText)){accessLabel='No plan';accessTone='';}
      else if(disabled){accessLabel='Disabled';accessTone='warn';}
      else if(accountCount>0){accessLabel='Active';accessTone='good';}
      else{accessLabel='Needs access';accessTone='bad';}

      const checkbox=row.cells[0]?.cloneNode(true)||el('td');
      const customerCell=customer?.cloneNode(true)||el('td','',id||'Customer');customerCell.setAttribute('data-label','Customer');
      const paidCell=el('td','operatorMetricCell');paidCell.setAttribute('data-label','Paid');paidCell.append(el('strong','operatorMetricMain',paid.main),el('span','operatorMetricSub',paid.sub));
      const usageCell=el('td','operatorMetricCell');usageCell.setAttribute('data-label','Usage');usageCell.append(el('strong',`operatorMetricMain${usage.live?' live':''}`,usage.main),el('span','operatorMetricSub',usage.sub));
      const planCell=el('td','operatorMetricCell');planCell.setAttribute('data-label','Current plan');planCell.append(el('strong','operatorMetricMain',planText),el('span','operatorMetricSub',statusText&&statusText!=='none'?statusText.replaceAll('_',' '):'No active subscription'));
      const accessCell=el('td','operatorAccessCell');accessCell.setAttribute('data-label','Access');accessCell.append(statusBadge(accessLabel,accessTone));if(metric.adminMode==='forced_server')accessCell.append(el('span','operatorMetricSub','Server chosen by admin'));
      const serverCell=server?.cloneNode(true)||el('td','', '—');serverCell.setAttribute('data-label','Server');
      const registeredCell=registered?.cloneNode(true)||el('td','', '—');registeredCell.setAttribute('data-label','Registered');
      const actionCell=el('td','operatorRowActions');actionCell.setAttribute('data-label','Actions');if(link){const manage=el('a',`button ${accessLabel==='Needs access'?'':'secondary'} btn-sm`,accessLabel==='Needs access'?'Fix access':'Manage');manage.href=link.getAttribute('href');actionCell.appendChild(manage);}
      row.replaceChildren(checkbox,customerCell,paidCell,usageCell,planCell,accessCell,serverCell,registeredCell,actionCell);
    });

    document.querySelectorAll('.formGroup').forEach(group=>{
      const label=text(group.querySelector(':scope > label'));
      if(label==='Access sync')group.remove();
      if(label==='Custom access'){const node=group.querySelector(':scope > label');if(node)node.textContent='Customer settings';}
    });
    const bulk=document.querySelector('#customerBulkAction');if(bulk){
      const labels={plan_change:'Change plan',migrate_server:'Move server',reconcile:'Fix access',retry_failed:'Retry access setup',jellyfin_delete:'Delete Jellyfin account(s)'};
      [...bulk.options].forEach(option=>{if(labels[option.value])option.textContent=labels[option.value];});
    }
  }

  function hidden(form,name,value){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=String(value??'');form.appendChild(input);return input;}
  function postForm(action,token,fields,label,{tone='secondary',className='plainForm'}={}){
    const form=el('form',className);form.method='post';form.action=action;form.dataset.nativeSubmit='true';hidden(form,'_csrf',token);Object.entries(fields||{}).forEach(([key,value])=>hidden(form,key,value));const button=el('button',`button ${tone}`,label);button.type='submit';form.appendChild(button);return form;
  }
  function bulkForm(customerId,token,action,label,tone='secondary'){return postForm('/admin/customers/bulk/preview',token,{customerId,action},label,{tone});}
  function serverLabel(server){
    const assigned=Number(server.assigned_users||0),max=Number(server.max_users||0);let capacity=max?`${assigned}/${max}`:`${assigned} users`;
    if(max&&assigned>max)capacity+=` · OVER +${assigned-max}`;else if(max&&assigned===max)capacity+=' · FULL';
    const flags=[];if(!server.enabled)flags.push('disabled');if(server.health_status&&server.health_status!=='healthy')flags.push(server.health_status);
    return`${server.name} · ${capacity}${flags.length?` · ${flags.join(', ')}`:''}`;
  }
  function serverSelect(context,name='serverId'){
    const select=el('select','input operatorServerSelect');select.name=name;select.required=true;
    const first=document.createElement('option');first.value='';first.textContent='Choose a server…';select.appendChild(first);
    for(const server of context.servers||[]){const option=document.createElement('option');option.value=server.id;option.textContent=serverLabel(server);option.disabled=!server.operable;option.dataset.full=server.full?'1':'0';option.dataset.assigned=String(server.assigned_users||0);option.dataset.max=String(server.max_users||0);option.dataset.serverName=server.name||'Server';option.dataset.serverClass=server.server_class||'';select.appendChild(option);}
    return select;
  }
  function addServerAction(panel,context,customerId,mode){
    const form=el('form','operatorServerAction');form.method='post';form.action=`/admin/users/${encodeURIComponent(customerId)}/operator/${mode}`;form.dataset.nativeSubmit='true';hidden(form,'_csrf',context.csrfToken);
    const select=serverSelect(context);form.appendChild(select);
    const button=el('button','button primary',mode==='move'?'Move to server':'Add to server');button.type='submit';form.appendChild(button);
    const warning=el('div','operatorOverrideWarning');warning.hidden=true;form.appendChild(warning);
    select.addEventListener('change',()=>{
      const option=select.selectedOptions[0];if(!option?.value){warning.hidden=true;button.textContent=mode==='move'?'Move to server':'Add to server';return;}
      const assigned=Number(option.dataset.assigned||0),max=Number(option.dataset.max||0),full=option.dataset.full==='1';const differentPool=context.entitlement?.serverClass&&option.dataset.serverClass&&context.entitlement.serverClass!==option.dataset.serverClass;
      const notices=[];
      if(full&&max)notices.push(`${option.dataset.serverName} is ${assigned}/${max}. Admin override is allowed; this customer will make it ${assigned+1}/${max} and public capacity stays full.`);
      if(differentPool)notices.push(`This server is outside the plan's normal ${context.entitlement.serverClass} pool. Your admin choice overrides automatic placement.`);
      warning.textContent=notices.join(' ');warning.hidden=!notices.length;button.textContent=full?(mode==='move'?'Move anyway':'Add anyway'):(mode==='move'?'Move to server':'Add to server');
    });
    panel.appendChild(form);
  }

  function friendlyNoticeCopy(){
    document.querySelectorAll('.notice').forEach(node=>{
      const current=text(node);if(/service access reconciled|reconciled against|reconcile(d|ment)? access/i.test(current))node.textContent='Jellyfin access updated successfully.';
    });
  }
  function replaceExactVisibleText(){
    const replacements=new Map([
      ['Reconcile access','Fix access'],['Reconcile','Fix access'],['Retry provisioning','Retry access setup'],['Try automatic provisioning','Add automatically'],['Provisioning','Access setup'],['Manual entitlement edit','Change plan'],['Make permanent','Make Permanent User'],['Remove permanent access','Remove Permanent Status'],['Reset expiry to subscription','Remove Permanent Status'],['Service reconciliation truth','Advanced service diagnostics'],['Reconciliation','Access check'],['Last reconciled','Last checked'],['Migrate to another Jellyfin server','Move server']
    ]);
    document.querySelectorAll('button,a,summary,h2,h3,.kvLabel,.accessEyebrow').forEach(node=>{const value=text(node);if(replacements.has(value))node.textContent=replacements.get(value);});
  }
  function collapseTechnicalSections(){
    const targets=[...document.querySelectorAll('.customerAccessTruth,.customerServiceTruth,.customerControlCentre,.accessOverviewSection')];
    targets.forEach((section,index)=>{
      if(section.closest('details.operatorLegacyDetails'))return;
      const details=el('details','operatorLegacyDetails');const summary=el('summary','',section.classList.contains('customerControlCentre')?'More customer controls':section.classList.contains('accessOverviewSection')?'Access details':'Advanced diagnostics');
      section.parentNode.insertBefore(details,section);details.append(summary,section);if(index===0&&section.classList.contains('customerControlCentre'))details.open=false;
    });
  }

  function operatorStatus(context){
    if(context.adminControl?.mode==='removed')return['Removed by admin','warn','Automatic setup is paused for this entitlement.'];
    if(context.permanent)return['Permanent User','good','Payments, expiry and inactivity cannot remove access.'];
    if(context.activeAccounts?.length)return['Active','good',context.adminControl?.mode==='forced_server'?'Server placement is pinned by administrator.':'Normal lifecycle rules apply.'];
    if(context.entitlement)return['Needs access','bad','The customer has a Jellyfin plan but no enabled Jellyfin account.'];
    return['No Jellyfin plan','','Choose a plan before adding Jellyfin access.'];
  }

  function buildOperatorPanel(context,customerId){
    const section=el('section','section operatorCustomerActions');section.id='customer-operator-actions';
    const head=el('div','sectionHead'),headText=el('div');headText.append(el('h2','','What do you want to do?'),el('div','muted','Direct administrator controls. Capacity and automatic placement rules never block an explicit server choice.'));
    const [status,tone,sub]=operatorStatus(context),badge=statusBadge(status,tone);head.append(headText,badge);section.appendChild(head);

    const summary=el('div','operatorCustomerSummary');
    const summaryItems=[['Plan',context.entitlement?.planName||'No Jellyfin plan'],['Jellyfin',context.activeAccounts?.length?`${context.activeAccounts.length} active account${context.activeAccounts.length===1?'':'s'}`:'No active account'],['Server',context.activeAccounts?.map(a=>a.server_name).filter(Boolean).join(', ')||context.adminControl?.serverName||'—'],['Management',context.permanent?'Permanent User':context.adminControl?.mode==='forced_server'?'Admin-selected server':context.adminControl?.mode==='removed'?'Removed by admin':'Automatic rules']];
    for(const [label,value] of summaryItems){const item=el('div');item.append(el('span','',label),el('strong','',value));summary.appendChild(item);}section.append(summary,el('div','operatorCustomerRule','',));section.lastChild.textContent=sub;

    const primary=el('div','operatorPrimaryActions');
    if(context.entitlement){
      if(context.activeAccounts?.length)addServerAction(primary,context,customerId,'move');else addServerAction(primary,context,customerId,'assign');
      primary.appendChild(postForm(`/admin/users/${encodeURIComponent(customerId)}/operator/fix`,context.csrfToken,{},'Fix access',{tone:'secondary'}));
      if(context.activeAccounts?.length||context.adminControl?.mode==='forced_server')primary.appendChild(postForm(`/admin/users/${encodeURIComponent(customerId)}/operator/remove`,context.csrfToken,{reason:'Removed from Jellyfin by administrator'},'Remove Jellyfin access',{tone:'secondary'}));
      if(context.adminControl)primary.appendChild(postForm(`/admin/users/${encodeURIComponent(customerId)}/operator/automatic`,context.csrfToken,{},'Return to automatic management',{tone:'secondary'}));
      primary.appendChild(postForm(`/admin/users/${encodeURIComponent(customerId)}/permanent-access`,context.csrfToken,{action:context.permanent?'revoke':'enable',reason:context.permanent?'Permanent status removed from customer operator console':'Permanent User enabled from customer operator console'},context.permanent?'Remove Permanent Status':'Make Permanent User',{tone:context.permanent?'secondary':'primary'}));
    }
    primary.appendChild(bulkForm(customerId,context.csrfToken,'plan_change','Change plan','secondary'));
    section.appendChild(primary);

    const more=el('details','operatorMoreActions');more.appendChild(el('summary','','More actions'));
    const moreBody=el('div','operatorMoreActionsBody');
    if(context.entitlement){moreBody.appendChild(bulkForm(customerId,context.csrfToken,'suspend','Suspend service access','secondary'));moreBody.appendChild(bulkForm(customerId,context.csrfToken,'end_jellyfin_plan','Cancel / end current plan','secondary'));}
    if(context.accounts?.length)moreBody.appendChild(bulkForm(customerId,context.csrfToken,'jellyfin_delete','Delete Jellyfin account(s)','secondary'));
    moreBody.appendChild(bulkForm(customerId,context.csrfToken,'portal_delete','Delete customer…','secondary'));more.appendChild(moreBody);section.appendChild(more);
    return section;
  }

  function relocatePortalAndTopActions(customerId){
    document.querySelectorAll('.topBarActions a,.coherenceSectionActions a').forEach(link=>{
      const href=link.getAttribute('href')||'';const label=text(link);
      if(href==='/admin/users'||href===`/admin/users/${customerId}?tab=activity`||label==='Back to Customers'||label==='Activity')link.remove();
    });
    document.querySelectorAll('[data-customer-management]').forEach(node=>node.remove());
    const nav=document.querySelector('.customerContextTabs,.detailTabs');
    const form=[...document.querySelectorAll(`form[action="/admin/users/${customerId}/impersonate"]`)].find(node=>!node.closest('.customerPortalTab'));
    if(nav&&form){
      const wrapper=el('div','customerPortalTab');form.parentNode?.removeChild(form);wrapper.appendChild(form);const button=form.querySelector('button');if(button){button.className='detailTab';button.textContent='View portal';button.title='Open the customer portal in read-only support mode';}nav.appendChild(wrapper);
    }
  }

  async function enhanceCustomerDetail(customerId){
    friendlyNoticeCopy();replaceExactVisibleText();relocatePortalAndTopActions(customerId);
    let context=null;
    try{const response=await fetch(`/admin/users/${encodeURIComponent(customerId)}/operator/context`,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(response.ok)context=await response.json();}catch(_){context=null;}
    if(context?.ok&&!document.querySelector('#customer-operator-actions')){
      const panel=buildOperatorPanel(context,customerId),nav=document.querySelector('.customerContextTabs,.detailTabs');
      if(nav)nav.insertAdjacentElement('afterend',panel);else(document.querySelector('.summaryGrid')||document.querySelector('.profileHero'))?.insertAdjacentElement('afterend',panel);
    }
    collapseTechnicalSections();replaceExactVisibleText();relocatePortalAndTopActions(customerId);
  }

  if(path==='/admin/users')enhanceCustomerList().catch(()=>{});
  else if(customerMatch){
    const customerId=customerMatch[1];enhanceCustomerDetail(customerId).catch(()=>{});
    // Other admin scripts add support actions shortly after first paint. Keep
    // the customer header/navigation compact if those nodes arrive late.
    const observer=new MutationObserver(()=>relocatePortalAndTopActions(customerId));observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
  }
})();
