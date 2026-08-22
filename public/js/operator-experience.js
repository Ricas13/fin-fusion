'use strict';

(() => {
  const path = location.pathname;

  const finalPolish=document.createElement('link');
  finalPolish.rel='stylesheet';
  finalPolish.href='/css/admin-final-polish.css';
  if(!document.querySelector('link[href="/css/admin-final-polish.css"]'))document.head.appendChild(finalPolish);

  const pageClass = path==='/admin' ? 'page-dashboard'
    : path==='/admin/users/dashboard' ? 'page-users-dashboard'
      : path==='/admin/commerce' ? 'page-commerce'
        : path==='/admin/automation' ? 'page-automation'
          : path==='/admin/activity' ? 'page-playback'
            : '';
  if(pageClass)document.body.classList.add(pageClass);

  // The product-level Overview screens became redundant once Servers/Sources
  // were redesigned as their real control rooms. Keep old bookmarks working,
  // but take operators straight to the canonical destination.
  if(path==='/admin/jellyfin'){location.replace('/admin/servers');return;}
  if(path==='/admin/stremio'){location.replace('/admin/servers/stremio');return;}

  function tabs(items, activeHref) {
    const wrap=document.createElement('nav');
    wrap.className='operatorTabs';
    wrap.setAttribute('aria-label','Page sections');
    items.forEach(([label,href])=>{
      const a=document.createElement('a');a.className='operatorTab';a.href=href;a.textContent=label;
      if((activeHref||path).startsWith(href.split('?')[0]) && (!href.includes('?') || location.search===href.slice(href.indexOf('?'))))a.classList.add('active');
      wrap.appendChild(a);
    });
    return wrap;
  }

  function insertAfterHeader(node){
    const header=document.querySelector('.pageHeader');
    if(header?.parentNode)header.insertAdjacentElement('afterend',node);
  }
  function callout(html,kind=''){
    const div=document.createElement('div');div.className=`operatorCallout ${kind}`;div.innerHTML=html;return div;
  }
  function appendTopAction(label,href,marker){
    if(marker&&document.querySelector(`[${marker}]`))return null;
    const link=document.createElement('a');link.className='button secondary';link.href=href;link.textContent=label;
    if(marker)link.setAttribute(marker,'1');
    const actions=document.querySelector('.topBarActions');
    if(actions)actions.appendChild(link);else document.querySelector('.pageHeader')?.appendChild(link);
    return link;
  }
  function repairCustomerVerificationMarkup(){
    document.querySelectorAll('.kvRow').forEach(row=>{
      const label=(row.querySelector('.kvLabel')?.textContent||'').trim();
      if(label!=='Email verified')return;
      const value=row.querySelector('.kvValue');if(!value)return;
      const literal=(value.textContent||'').trim();
      const good='<span class="pill good">Verified</span>';
      const bad='<span class="pill bad">Not verified</span>';
      let prefix=null,kind=null;
      if(literal.startsWith(good)){prefix=good;kind='good';}
      else if(literal.startsWith(bad)){prefix=bad;kind='bad';}
      if(!prefix)return;
      const pill=document.createElement('span');pill.className=`pill ${kind}`;pill.textContent=kind==='good'?'Verified':'Not verified';
      const tail=literal.slice(prefix.length).trim();value.replaceChildren(pill);
      if(tail)value.append(document.createTextNode(` ${tail}`));
    });
  }

  function paginateTable(container,{pageSize=25,label='items'}={}){
    if(!container||container.querySelector(':scope > .operatorPager, .tableWrap + .operatorPager'))return;
    const tbody=container.querySelector('table tbody');
    if(!tbody)return;
    const rows=[...tbody.children].filter(row=>row.tagName==='TR');
    if(rows.length<=pageSize)return;
    const pages=Math.ceil(rows.length/pageSize);
    let page=0;
    const pager=document.createElement('nav');pager.className='operatorPager';pager.setAttribute('aria-label',`${label} pages`);
    const meta=document.createElement('span');meta.className='operatorPagerMeta';
    const buttons=document.createElement('div');buttons.className='operatorPagerButtons';
    pager.append(meta,buttons);
    const wrap=container.querySelector('.tableWrap');
    (wrap||tbody.closest('table')).insertAdjacentElement('afterend',pager);

    function button(text,target,{active=false,disabled=false,aria=''}={}){
      const el=document.createElement('button');el.type='button';el.className=`operatorPageButton${active?' active':''}`;el.textContent=text;el.disabled=disabled;
      if(aria)el.setAttribute('aria-label',aria);if(active)el.setAttribute('aria-current','page');
      el.addEventListener('click',()=>{page=target;render();});return el;
    }
    function render(){
      const start=page*pageSize,end=Math.min(rows.length,start+pageSize);
      rows.forEach((row,index)=>{row.hidden=index<start||index>=end;});
      meta.textContent=`${start+1}–${end} of ${rows.length} ${label} · ${pageSize} per page`;
      buttons.replaceChildren();
      buttons.appendChild(button('‹',Math.max(0,page-1),{disabled:page===0,aria:'Previous page'}));
      for(let i=0;i<pages;i+=1){
        if(pages>9 && i>1 && i<pages-2 && Math.abs(i-page)>1){
          if((i===2&&page>3)||(i===pages-3&&page<pages-4)){const gap=document.createElement('span');gap.className='operatorPagerMeta';gap.textContent='…';buttons.appendChild(gap);}
          continue;
        }
        buttons.appendChild(button(String(i+1),i,{active:i===page,aria:`Page ${i+1}`}));
      }
      buttons.appendChild(button('›',Math.min(pages-1,page+1),{disabled:page===pages-1,aria:'Next page'}));
    }
    render();
  }

  // Portal claims are part of the Jellyfin import workflow, not a separate
  // top-level People application.
  if(path.startsWith('/admin/customer-claims') || path==='/admin/jellyfin-import'){
    insertAfterHeader(tabs([['Import Jellyfin users','/admin/jellyfin-import'],['Portal claims','/admin/customer-claims']],path));
  }

  // Customer 360 is an overview. Only UUID-shaped /admin/users/:id routes are
  // customer records; reserved pages such as /admin/users/dashboard must never
  // trigger customer-management requests with a page name as the customer ID.
  // Single-customer bulk preview forms must submit natively because their
  // successful response is a full confirmation page, not an inline fragment.
  const customerMatch=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(customerMatch){
    const customerId=decodeURIComponent(customerMatch[1]);
    const base=`/admin/users/${encodeURIComponent(customerId)}`;
    appendTopAction('Manage customer',`${base}/manage`,'data-customer-management');
    document.querySelectorAll('form[action="/admin/customers/bulk/preview"]').forEach(form=>{
      if(form.querySelector('input[name="customerId"]'))form.dataset.nativeSubmit='true';
    });
    repairCustomerVerificationMarkup();
    fetch(`${base}/manage/context`,{headers:{Accept:'application/json'},credentials:'same-origin'})
      .then(r=>r.ok?r.json():null)
      .then(context=>{
        if(!context?.ok)return;
        if(context.hasJellyfinAccount)appendTopAction('Change Jellyfin password',`/admin/customer-jellyfin-password?customerId=${encodeURIComponent(customerId)}`,'data-customer-password-support');
        if(context.stremioEligible){
          document.querySelectorAll(`a[href="${base}?tab=access"]`).forEach(link=>{link.href=`${base}/manage#stremio-installation`;if((link.textContent||'').trim()==='View service access')link.textContent='Stremio installation';});
          const accessTab=[...document.querySelectorAll('a')].find(a=>(a.getAttribute('href')||'')===`${base}?tab=access`&&(a.textContent||'').trim()==='Access');
          if(accessTab){accessTab.href=`${base}/manage#stremio-installation`;accessTab.textContent='Stremio';}
          document.querySelectorAll('form[action="/admin/customers/bulk/preview"]').forEach(form=>{
            const action=form.querySelector('input[name="action"]');
            if(action?.value==='retry_failed'){
              action.value='reconcile';
              const button=form.querySelector('button[type="submit"],button:not([type])');if(button)button.textContent='Retry Stremio setup';
            }
          });
        }
      }).catch(()=>{});
  }

  // Customer and plan pages render their own compact filters server-side.
  // Do not add client-side product tabs or move fields after page load.

  // Payments, Notifications, Provisioning and Backups/Transfer render their
  // workflow navigation server-side. Do not add a second client-side tab row.
  if(path==='/admin/notifications/preferences'){
    document.querySelectorAll('.buttonRow a[href="/admin/email"],.buttonRow a[href="/admin/profile/notifications"]').forEach(link=>link.remove());
    document.querySelectorAll('form[action="/admin/notifications/preferences/delivery"] .formGroup').forEach(group=>{
      const legacyLabel=[...group.querySelectorAll(':scope > label')].find(label=>(label.textContent||'').trim().startsWith('Legacy global destination'));
      const legacyInput=legacyLabel?.nextElementSibling;
      if(!legacyLabel||!legacyInput||legacyInput.tagName!=='INPUT')return;
      const details=document.createElement('details');details.className='operatorDisclosure notificationLegacyDestination';
      const summary=document.createElement('summary');summary.textContent='Legacy/manual destination';
      const body=document.createElement('div');body.className='operatorDisclosureBody';
      legacyLabel.parentNode.insertBefore(details,legacyLabel);
      body.append(legacyLabel,legacyInput);details.append(summary,body);
    });
  }

  if(path==='/admin/activity'){
    insertAfterHeader(tabs([['Live playback','/admin/activity'],['Inactivity rules','/admin/activity/inactivity-policy']],path));
    const banner=document.querySelector('.statusBanner');
    const info=callout('<strong>Where do the actual stream limits come from?</strong> Customer concurrency and delivery limits come from the customer’s <a href="/admin/plans">plan</a>. This page chooses what CAPTAiNFiN does when live Jellyfin activity exceeds those effective limits: Observe, Warn or Enforce. <a href="/admin/activity/inactivity-policy">Free-user inactivity rules are configured separately.</a>','');
    if(banner)banner.insertAdjacentElement('afterend',info);else insertAfterHeader(info);

    paginateTable(document.querySelector('#active-streams'),{label:'active streams'});
    const details=[...document.querySelectorAll('details.operatorDetails')];
    const policyHistory=details.find(item=>(item.querySelector(':scope > summary')?.textContent||'').includes('Full policy event history'));
    const playbackHistory=details.find(item=>(item.querySelector(':scope > summary')?.textContent||'').includes('Routine playback history'));
    paginateTable(policyHistory,{label:'policy events'});
    paginateTable(playbackHistory,{label:'playback records'});
  }
  if(path.startsWith('/admin/activity/inactivity-policy')){
    insertAfterHeader(tabs([['Live playback','/admin/activity'],['Inactivity rules','/admin/activity/inactivity-policy']],path));
  }

  if(path==='/admin/attention'){
    document.querySelectorAll('form').forEach(form=>{
      const selects=form.querySelectorAll('select');
      if(selects.length>=1 && (form.textContent||'').toLowerCase().includes('note'))form.classList.add('attentionActionGrid');
    });
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-copy-value],[data-copy-link]');if(!button)return;
    const value=button.getAttribute('data-copy-value')||button.getAttribute('data-copy-link')||'';
    navigator.clipboard?.writeText(value).then(()=>{const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}).catch(()=>{});
  });

  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-operator-alerts]');
    const menu=document.querySelector('[data-operator-alert-menu]');
    if(trigger&&menu){
      const open=menu.hidden;
      menu.hidden=!open;
      trigger.setAttribute('aria-expanded',open?'true':'false');
      return;
    }
    if(menu&&!menu.hidden&&!event.target.closest('.topStatusWrap')){
      menu.hidden=true;
      document.querySelector('[data-operator-alerts]')?.setAttribute('aria-expanded','false');
    }
  });

  // Business unread badges and the top Status summary are owned exclusively by
  // operator-business-indicators.js. That implementation persists a server-side
  // administrator read cursor, so opening Customers Overview and Customers are
  // intentionally the same read workspace. Do not reintroduce localStorage or a
  // second /operator-state/unread fetch here.

  document.querySelectorAll('[title]:not([data-help])').forEach(el => {
    const value = (el.getAttribute('title') || '').trim();
    if (value.length > 5 && value.length < 180) el.setAttribute('data-help', value);
  });
})();
