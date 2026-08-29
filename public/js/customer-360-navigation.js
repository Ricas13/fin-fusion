'use strict';

(() => {
  const match=location.pathname.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if(!match)return;

  const customerId=decodeURIComponent(match[1]);
  const base=`/admin/users/${encodeURIComponent(customerId)}`;
  const tabs=[
    ['overview','Overview',`${base}?tab=overview`],
    ['access','Access',`${base}?tab=access`],
    ['activity','Activity',`${base}?tab=activity`],
    ['billing','Billing',`${base}?tab=billing`],
    ['security','Security',`${base}?tab=security`],
    ['history','History',`${base}?tab=history`]
  ];

  function activeTab(){
    const tab=new URLSearchParams(location.search).get('tab')||'overview';
    return tabs.some(([key])=>key===tab)?tab:'overview';
  }

  function buildNavigation(){
    const nav=document.createElement('nav');
    nav.className='detailTabs customerContextTabs';
    nav.setAttribute('aria-label','Customer sections');
    const active=activeTab();
    for(const [key,label,href] of tabs){
      const link=document.createElement('a');
      link.className=`detailTab${key===active?' active':''}`;
      link.href=href;
      link.textContent=label;
      if(key===active)link.setAttribute('aria-current','page');
      nav.appendChild(link);
    }
    return nav;
  }

  function normalizeNavigation(){
    // The older journey cards duplicated Account/Access/Billing/Activity and
    // consumed most of the viewport. Customer 360 has one canonical tab bar.
    document.querySelectorAll('.customerJourneySteps').forEach(node=>node.remove());

    let nav=document.querySelector('.customerContextTabs');
    const legacy=document.querySelector('.detailTabs:not(.customerContextTabs)');
    if(legacy){
      nav=buildNavigation();
      legacy.replaceWith(nav);
    }else if(!nav){
      nav=buildNavigation();
      const summary=document.querySelector('.profileHero + .summaryGrid')||document.querySelector('.summaryGrid');
      if(summary)summary.insertAdjacentElement('afterend',nav);
      else document.querySelector('.profileHero')?.insertAdjacentElement('afterend',nav);
    }

    // Keep every tab deterministic. The general operator script used to turn
    // Stremio Access into a jump to the separate management page after an async
    // context request, which made the navigation mutate underneath the user.
    if(nav){
      const active=activeTab();
      [...nav.querySelectorAll('a')].forEach((link,index)=>{
        const item=tabs[index];
        if(!item)return;
        const [key,label,href]=item;
        if(link.getAttribute('href')!==href)link.setAttribute('href',href);
        if(link.textContent!==label)link.textContent=label;
        link.classList.toggle('active',key===active);
        if(key===active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
      });
    }

    // Customer identity, current plan and the persistent navigation should be
    // encountered before the override toolbox. This keeps the page oriented
    // around the customer rather than around administrator mutations.
    if(nav){
      const controls=document.querySelector('.customerControlCentre');
      if(controls&&controls.previousElementSibling!==nav)nav.insertAdjacentElement('afterend',controls);
    }
  }

  function normalizeTopActions(){
    const actions=document.querySelector('.topBarActions');
    if(!actions)return;

    // Activity and management are sections of the persistent customer nav, not
    // separate top-bar destinations. Password support already lives in Access.
    actions.querySelectorAll('[data-customer-management],[data-customer-password-support]').forEach(node=>node.remove());
    actions.querySelectorAll('a').forEach(link=>{
      const href=link.getAttribute('href')||'';
      if(href===`${base}?tab=activity`)link.remove();
    });
  }

  function normalize(){normalizeNavigation();normalizeTopActions();}
  normalize();

  // operator-experience.js enriches customer pages asynchronously. Observe the
  // small set of mutations it can make so customer navigation never changes a
  // moment after first paint.
  const observer=new MutationObserver(()=>normalize());
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
  setTimeout(()=>observer.disconnect(),5000);
})();