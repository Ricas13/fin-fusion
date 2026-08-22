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

  function currentHrefMatches(href){
    const target=new URL(href,location.origin);
    if(target.pathname!==path)return false;
    if(!target.search)return !location.search || !['/admin/settings'].includes(path);
    return target.searchParams.get('section')===new URLSearchParams(location.search).get('section');
  }
  function controlRoomCards(items,label){
    const nav=document.createElement('nav');
    nav.className='workflowCardGrid';
    nav.setAttribute('aria-label',label);
    items.forEach(([title,href,description])=>{
      const active=currentHrefMatches(href);
      const link=document.createElement('a');
      link.className=`workflowCard${active?' active':''}`;
      link.href=href;
      if(active)link.setAttribute('aria-current','page');
      const eyebrow=document.createElement('span');eyebrow.className='workflowCardEyebrow';eyebrow.textContent=active?'Current':'Related';
      const heading=document.createElement('strong');heading.textContent=title;
      const text=document.createElement('span');text.textContent=description;
      const action=document.createElement('small');action.textContent=active?'You are here':'Open →';
      link.append(eyebrow,heading,text,action);nav.appendChild(link);
    });
    return nav;
  }
  function condensedWorkflow(){
    if(document.querySelector('.workflowCardGrid'))return;
    const search=new URLSearchParams(location.search);
    const section=search.get('section');
    const workflows=[
      {match:()=>path==='/admin'||path==='/admin/attention',label:'Dashboard control room',items:[
        ['Dashboard','/admin','Current state, business performance and highest-priority exceptions'],
        ['Needs Attention','/admin/attention','Assignment, acknowledgement and bulk handling for live operational issues']
      ]},
      {match:()=>['/admin/servers','/admin/servers/operations','/admin/libraries'].includes(path),label:'Jellyfin server control room',items:[
        ['Servers','/admin/servers','Fleet health, credentials, capacity and server inventory'],
        ['Placement','/admin/servers/operations','Placement modes, health policy and future-capacity preview'],
        ['Libraries','/admin/libraries','Fleet library discovery, availability and visibility']
      ]},
      {match:()=>['/admin/servers/stremio','/admin/stremio/playback'].includes(path),label:'Stremio control room',items:[
        ['Sources & indexing','/admin/servers/stremio','Runtime readiness, sources, libraries, credentials and indexes'],
        ['Household & IP access','/admin/stremio/playback','Current network leases and managed playback activity']
      ]},
      {match:()=>['/admin/resellers','/admin/resellers/resellers'].includes(path),label:'Reseller control room',items:[
        ['Resellers','/admin/resellers','Programme state and future reseller commercial model'],
        ['Accounts','/admin/resellers/resellers','Reserved reseller organisations and account state']
      ]},
      {match:()=>['/admin/users','/admin/users/dashboard'].includes(path),label:'Customer control room',items:[
        ['Customers','/admin/users','Search, filter and manage customer access'],
        ['Customer activity','/admin/users/dashboard','Lifecycle, growth, access and recent customer activity']
      ]},
      {match:()=>['/admin/plans','/admin/plans/order','/admin/request-plan-policy','/admin/plans/access-rules'].includes(path),label:'Plans and storefront control room',items:[
        ['Plans','/admin/plans','Products, pricing, access policy and availability'],
        ['Storefront order','/admin/plans/order','Control how purchasable plans are presented'],
        ['Request limits','/admin/request-plan-policy','Movie and TV request-service quotas by plan'],
        ['Access rules','/admin/plans/access-rules','Advanced plan access and delivery rules']
      ]},
      {match:()=>['/admin/orders','/admin/commerce','/admin/discounts','/admin/referrals'].includes(path),label:'Orders and growth control room',items:[
        ['Orders','/admin/orders','Customer orders, completion state and fulfilment'],
        ['Commerce analytics','/admin/commerce','Revenue, MRR, churn, checkout and plan performance'],
        ['Discounts','/admin/discounts','Promotions, coupon rules and redemption state'],
        ['Affiliates','/admin/referrals','Affiliate referrals and service-credit rewards']
      ]},
      {match:()=>['/admin/automation','/admin/events'].includes(path),label:'Automation control room',items:[
        ['Automation','/admin/automation','Worker health, schedules, failures and manual runs'],
        ['Audit log','/admin/events','Full operator and system action history']
      ]},
      {match:()=>path==='/admin/settings'&&section==='general'||['/admin/settings/branding','/admin/settings/support'].includes(path),label:'General settings control room',items:[
        ['General','/admin/settings?section=general','Platform identity, URL, locale, timezone and workflow defaults'],
        ['Branding','/admin/settings/branding','Shared logo and browser icon'],
        ['Support & legal','/admin/settings/support','Support, docs, policies and business identity']
      ]},
      {match:()=>path==='/admin/settings'&&section==='security'||['/admin/settings/admin-2fa','/admin/settings/abuse-protection','/admin/security'].includes(path),label:'Security control room',items:[
        ['Security','/admin/settings?section=security','Registration, sessions, trusted networks and authentication policy'],
        ['Turnstile & abuse protection','/admin/settings/abuse-protection','Cloudflare checks for staff/customer sign-in and public registration'],
        ['Administrator 2FA','/admin/settings/admin-2fa','Global staff two-factor policy']
      ]},
      {match:()=>path==='/admin/settings'&&section==='integrations'||['/admin/notifications/preferences','/admin/notifications/email','/admin/notifications','/admin/request-users'].includes(path),label:'Connections control room',items:[
        ['Connections','/admin/settings?section=integrations','At-a-glance external service readiness and entry points'],
        ['Notifications','/admin/notifications/preferences','Global notification channels and event permissions'],
        ['Email','/admin/notifications/email','SMTP infrastructure and validation'],
        ['Delivery health','/admin/notifications','Notification queue and delivery state'],
        ['Request service','/admin/request-users','Request-service connection and account synchronisation']
      ]}
    ];
    const workflow=workflows.find(item=>item.match());
    if(workflow)insertAfterHeader(controlRoomCards(workflow.items,workflow.label));
  }
  condensedWorkflow();

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
  // workflow navigation server-side. Do not add a second client-side card row.
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
