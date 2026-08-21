'use strict';

(() => {
  const path = location.pathname;

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

  // The common customer search fields stay visible; less frequently used fields
  // remain inside the same GET form under an explicit disclosure.
  if(path==='/admin/users'){
    const form=document.querySelector('form.filterForm');
    const grid=form?.querySelector('.formGrid');
    if(form&&grid&&grid.children.length>6){
      const groups=[...grid.children];
      const basicLabels=new Set(['Search','Server','Plan','Subscription status','Account status','Last active to']);
      const extended=groups.filter(group=>!basicLabels.has((group.querySelector('label')?.textContent||'').trim()));
      if(extended.length){
        const details=document.createElement('details');details.className='operatorDisclosure';
        const summary=document.createElement('summary');summary.textContent='Extended filters';
        const body=document.createElement('div');body.className='operatorDisclosureBody formGrid';
        extended.forEach(el=>body.appendChild(el));details.append(summary,body);
        grid.insertAdjacentElement('afterend',details);
      }
    }
  }

  // Catalogue filters belong only to direct customer plan browsing / creation.
  const planCataloguePage=path==='/admin/plans' || path==='/admin/plans/new';
  if(planCataloguePage){
    const type=new URLSearchParams(location.search).get('type')||'';
    const active=type?`/admin/plans?type=${encodeURIComponent(type)}`:'/admin/plans';
    insertAfterHeader(tabs([
      ['All plans','/admin/plans'],
      ['Jellyfin','/admin/plans?type=jellyfin'],
      ['Stremio','/admin/plans?type=stremio'],
      ['Bundles','/admin/plans?type=bundle']
    ],active));
  }

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
