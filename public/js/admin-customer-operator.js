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
    try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP'),currencyDisplay:'narrowSymbol',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(minor||0)/100);}catch(_){const value=(Number(minor||0)/100).toFixed(2),symbol={GBP:'£',USD:'$',EUR:'€'}[String(currency||'GBP').toUpperCase()]||'';return`${symbol}${value}`;}
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
  function wrapInDisclosure(sections,label){
    if(!sections.length||sections[0].closest('details.operatorLegacyDetails'))return;
    const details=el('details','operatorLegacyDetails');const summary=el('summary','',label);
    sections[0].parentNode.insertBefore(details,sections[0]);details.appendChild(summary);
    for(const section of sections)details.appendChild(section);
  }
  function collapseTechnicalSections(){
    // Access truth and Service reconciliation truth are always rendered as
    // adjacent siblings (accessTruthPanel appends serviceTruthPanel directly)
    // and describe the same "why is access in this state" diagnosis, so they
    // share one disclosure instead of two separate ones both labeled
    // "Advanced diagnostics".
    const accessTruth=document.querySelector('.customerAccessTruth');
    if(accessTruth&&!accessTruth.closest('details.operatorLegacyDetails')){
      const serviceTruth=accessTruth.nextElementSibling?.classList.contains('customerServiceTruth')?accessTruth.nextElementSibling:null;
      wrapInDisclosure(serviceTruth?[accessTruth,serviceTruth]:[accessTruth],'Advanced diagnostics');
    }
    const orphanServiceTruth=document.querySelector('.customerServiceTruth');
    if(orphanServiceTruth&&!orphanServiceTruth.closest('details.operatorLegacyDetails'))wrapInDisclosure([orphanServiceTruth],'Advanced diagnostics');
    document.querySelectorAll('.customerControlCentre,.accessOverviewSection').forEach(section=>{
      wrapInDisclosure([section],section.classList.contains('customerControlCentre')?'More customer controls':'Access details');
    });
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

  // The Customer control grid (Plan/Jellyfin account/Server/Management/
  // Access holds/Expiry/Reconcile/Portal/More) is server-rendered directly
  // from this same operator context on page load, so this no longer fetches
  // context or builds a client-side actions panel -- doing so would inject a
  // second, differently-styled duplicate of the server-rendered grid.
  function enhanceCustomerDetail(customerId){
    friendlyNoticeCopy();replaceExactVisibleText();relocatePortalAndTopActions(customerId);
    collapseTechnicalSections();replaceExactVisibleText();relocatePortalAndTopActions(customerId);
  }

  if(path==='/admin/users')enhanceCustomerList().catch(()=>{});
  else if(customerMatch){
    const customerId=customerMatch[1];try{enhanceCustomerDetail(customerId);}catch(_){}
    // Other admin scripts add support actions shortly after first paint. Keep
    // the customer header/navigation compact if those nodes arrive late.
    const observer=new MutationObserver(()=>relocatePortalAndTopActions(customerId));observer.observe(document.body,{childList:true,subtree:true});setTimeout(()=>observer.disconnect(),5000);
  }
})();