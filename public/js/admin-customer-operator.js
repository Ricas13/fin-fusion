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
  function cellByLabel(row,label){return [...row.children].find(cell=>cell.getAttribute('data-label')===label)||null;}
  function statusBadge(label,tone){const span=el('span',`pill ${tone||''}`,label);return span;}
  function headerKey(th){return text(th).replace(/[↑↓]/g,'').trim();}
  function sortableHeading(label,sourceLabel,sortLinks){
    const th=el('th');
    const source=sortLinks.get(sourceLabel);
    if(!source){th.textContent=label;return th;}
    const link=source.cloneNode(true),arrow=link.querySelector('.sortArrow');
    link.replaceChildren(document.createTextNode(label));
    if(arrow)link.append(document.createTextNode(' '),arrow);
    th.appendChild(link);
    const sourceTh=source.closest('th');
    if(sourceTh?.hasAttribute('aria-sort'))th.setAttribute('aria-sort',sourceTh.getAttribute('aria-sort'));
    return th;
  }

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
      const oldCheckbox=head.querySelector('#checkAllPage')?.cloneNode(true)||null;
      const sortLinks=new Map([...head.cells].map(th=>[headerKey(th),th.querySelector('a.tableSortLink')]).filter(([,link])=>link));
      head.replaceChildren();
      const selectTh=el('th');if(oldCheckbox)selectTh.appendChild(oldCheckbox);head.appendChild(selectTh);
      head.appendChild(sortableHeading('Customer','Customer',sortLinks));
      head.appendChild(el('th','','Paid'));
      head.appendChild(sortableHeading('Current plan','Plan',sortLinks));
      head.appendChild(sortableHeading('Access','Status',sortLinks));
      head.appendChild(sortableHeading('Server','Server',sortLinks));
      head.appendChild(sortableHeading('Registered','Registered',sortLinks));
      head.appendChild(el('th','','Actions'));
    }

    rows.forEach(row=>{
      const customer=cellByLabel(row,'Customer'),plan=cellByLabel(row,'Plan'),status=cellByLabel(row,'Status'),jellyfin=cellByLabel(row,'Jellyfin'),server=cellByLabel(row,'Server'),registered=cellByLabel(row,'Registered');
      const link=customer?.querySelector('a[href^="/admin/users/"]'),match=(link?.getAttribute('href')||'').match(/^\/admin\/users\/([0-9a-f-]{36})/i),id=match?.[1],metric=metrics[id]||{};
      const accountText=text(jellyfin),accountCount=Number.parseInt(accountText,10)||0,disabled=/disabled/i.test(accountText),planText=text(plan)||'No plan',statusText=text(status).toLowerCase(),freePlan=/free/i.test(planText);
      const paid=paidSummary(metric,freePlan);
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
      const planCell=el('td','operatorMetricCell');planCell.setAttribute('data-label','Current plan');planCell.append(el('strong','operatorMetricMain',planText),el('span','operatorMetricSub',statusText&&statusText!=='none'?statusText.replaceAll('_',' '):'No active subscription'));
      const accessCell=el('td','operatorAccessCell');accessCell.setAttribute('data-label','Access');accessCell.append(statusBadge(accessLabel,accessTone));if(metric.adminMode==='forced_server')accessCell.append(el('span','operatorMetricSub','Server chosen by admin'));
      const serverCell=server?.cloneNode(true)||el('td','', '—');serverCell.setAttribute('data-label','Server');
      const registeredCell=registered?.cloneNode(true)||el('td','', '—');registeredCell.setAttribute('data-label','Registered');
      const actionCell=el('td','operatorRowActions');actionCell.setAttribute('data-label','Actions');if(link){const manage=el('a',`button ${accessLabel==='Needs access'?'':'secondary'} btn-sm`,accessLabel==='Needs access'?'Fix access':'Manage');manage.href=link.getAttribute('href');actionCell.appendChild(manage);}
      row.replaceChildren(checkbox,customerCell,paidCell,planCell,accessCell,serverCell,registeredCell,actionCell);
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

    // The modern Customer 360 hero owns the portal action. Older code moved
    // this form into .customerContextTabs, but that legacy tab bar is wrapped
    // in .customerLegacyNav and intentionally hidden. Moving the form there
    // after first paint made "View User Page" flash briefly and disappear.
    const heroForm=document.querySelector(`.customerMockTopActions form[action="/admin/users/${customerId}/impersonate"]`);
    if(heroForm){
      heroForm.dataset.nativeSubmit='true';
      const button=heroForm.querySelector('button');
      if(button){button.textContent='View User Page ↗';button.title='Open this customer’s portal view';}
    }

    // Keep the hidden legacy navigation from retaining a second portal action.
    document.querySelectorAll(`.customerLegacyNav form[action="/admin/users/${customerId}/impersonate"]`).forEach(form=>form.remove());
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
    // A continuous MutationObserver on document.body here previously
    // re-triggered on every DOM mutation on the page - including its own -
    // which could pin the main thread for its whole run (the same freeze
    // fixed for admin-customer-primary-actions.js). A couple of bounded,
    // one-shot re-checks is enough to catch late-arriving nodes.
    try{requestAnimationFrame(()=>relocatePortalAndTopActions(customerId));}catch(_){}
    setTimeout(()=>{try{relocatePortalAndTopActions(customerId);}catch(_){}},250);
  }
})();