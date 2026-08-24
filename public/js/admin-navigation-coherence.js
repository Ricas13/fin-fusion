'use strict';

(() => {
  const path=location.pathname;
  const search=new URLSearchParams(location.search);

  if(!document.querySelector('link[href="/css/admin-navigation-coherence.css"]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/css/admin-navigation-coherence.css';
    document.head.appendChild(link);
  }

  function current(href,group){
    const target=new URL(href,location.origin);
    if(group==='settings'){
      const section=search.get('section')||'';
      if(target.pathname==='/admin/system')return path==='/admin/system';
      if(target.searchParams.get('section')==='general')return path==='/admin/settings'&&(!section||section==='general')||['/admin/settings/branding','/admin/settings/support','/admin/setup'].some(prefix=>path.startsWith(prefix));
      if(target.searchParams.get('section')==='security')return path==='/admin/settings'&&section==='security'||path.startsWith('/admin/settings/admin-2fa')||path.startsWith('/admin/settings/abuse-protection')||path==='/admin/security';
      if(target.searchParams.get('section')==='integrations')return path==='/admin/settings/integrations'||path==='/admin/settings'&&section==='integrations'||path.startsWith('/admin/notifications')||path==='/admin/request-users';
      if(target.searchParams.get('section')==='commerce')return path==='/admin/settings'&&section==='commerce';
    }
    return path===target.pathname||path.startsWith(target.pathname.endsWith('/')?target.pathname:target.pathname+'/');
  }

  function nav(items,{label='Section navigation',group='',className='coherenceSectionTabs'}={}){
    const el=document.createElement('nav');
    el.className=className;
    el.setAttribute('aria-label',label);
    items.forEach(([text,href])=>{
      const a=document.createElement('a');
      a.className=className==='coherenceSectionTabs'?'coherenceSectionTab':'coherenceSubTab';
      a.href=href;
      a.textContent=text;
      if(current(href,group)){
        a.classList.add('active');
        a.setAttribute('aria-current','page');
      }
      el.appendChild(a);
    });
    return el;
  }

  function insertPrimary(node){
    if(document.querySelector('.coherenceSectionTabs'))return;
    const header=document.querySelector('.pageHeader');
    if(header?.parentNode)header.insertAdjacentElement('afterend',node);
  }
  function insertSub(node){
    if(document.querySelector('.coherenceSubTabs'))return;
    const primary=document.querySelector('.coherenceSectionTabs');
    if(primary)primary.insertAdjacentElement('afterend',node);
    else{
      const header=document.querySelector('.pageHeader');
      if(header?.parentNode)header.insertAdjacentElement('afterend',node);
    }
  }
  function removeWorkflow(label){
    document.querySelectorAll('.workflowCardGrid').forEach(el=>{
      if((el.getAttribute('aria-label')||'')===label)el.remove();
    });
  }

  const settingsOwned=path.startsWith('/admin/settings')||path==='/admin/system'||path==='/admin/security'||path==='/admin/setup'||path.startsWith('/admin/notifications')||path==='/admin/request-users';
  if(settingsOwned){
    insertPrimary(nav([
      ['General','/admin/settings?section=general'],
      ['Security','/admin/settings?section=security'],
      ['Connections','/admin/settings/integrations'],
      ['Commerce','/admin/settings?section=commerce'],
      ['System','/admin/system']
    ],{label:'Settings sections',group:'settings'}));
  }

  const jellyfinOwned=path==='/admin/servers'||path.startsWith('/admin/servers/')||path==='/admin/libraries'||path==='/admin/activity'||path.startsWith('/admin/activity/');
  if(jellyfinOwned){
    insertPrimary(nav([
      ['Servers','/admin/servers'],
      ['Playback','/admin/activity']
    ],{label:'Jellyfin sections'}));
    if(path==='/admin/activity'||path.startsWith('/admin/activity/')){
      const existing=[...document.querySelectorAll('.operatorTabs')].find(el=>el.querySelector('a[href="/admin/activity/inactivity-policy"]'));
      if(!existing)insertSub(nav([
        ['Live playback','/admin/activity'],
        ['Inactivity rules','/admin/activity/inactivity-policy']
      ],{label:'Playback sections',className:'coherenceSubTabs'}));
    }
  }

  const planOwned=path==='/admin/plans'||path.startsWith('/admin/plans/');
  const growthOwned=path==='/admin/commerce'||path==='/admin/commerce/orders'||path.startsWith('/admin/commerce/orders/')||path==='/admin/discounts'||path.startsWith('/admin/discounts/')||path==='/admin/referrals'||path.startsWith('/admin/referrals/');
  const paymentsOwned=path==='/admin/payments'||path.startsWith('/admin/payments/')||path==='/admin/billing'||path.startsWith('/admin/billing/')||path==='/admin/provider-mappings'||path.startsWith('/admin/provider-mappings/');
  if(planOwned||growthOwned||paymentsOwned){
    insertPrimary(nav([
      ['Plans & Storefront','/admin/plans'],
      ['Orders & Growth','/admin/commerce/orders'],
      ['Payments & Billing','/admin/payments']
    ],{label:'Commerce sections'}));

    if(planOwned){
      removeWorkflow('Plans and storefront control room');
      insertSub(nav([
        ['Plans','/admin/plans'],
        ['Storefront order','/admin/plans/order'],
        ['Access rules','/admin/plans/access-rules']
      ],{label:'Plans and storefront sections',className:'coherenceSubTabs'}));
    }
    if(growthOwned){
      removeWorkflow('Orders and growth control room');
      insertSub(nav([
        ['Orders','/admin/commerce/orders'],
        ['Commerce analytics','/admin/commerce'],
        ['Discounts','/admin/discounts'],
        ['Affiliates','/admin/referrals']
      ],{label:'Orders and growth sections',className:'coherenceSubTabs'}));
    }
    if(paymentsOwned){
      document.querySelectorAll('.workflowCardGrid').forEach(el=>{
        const hrefs=[...el.querySelectorAll('a')].map(a=>a.getAttribute('href'));
        if(hrefs.includes('/admin/payments')&&hrefs.includes('/admin/billing'))el.remove();
      });
      insertSub(nav([
        ['Providers','/admin/payments'],
        ['Billing','/admin/billing'],
        ['Provider mappings','/admin/provider-mappings'],
        ['Payment risk','/admin/payments/risk-policy']
      ],{label:'Payments and billing sections',className:'coherenceSubTabs'}));
    }
  }

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings'&&search.get('section')==='commerce')document.body.classList.add('page-settings-commerce');
})();
