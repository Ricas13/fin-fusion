'use strict';

(() => {
  const path = location.pathname;
  const pageKey = document.querySelector('.adminTab.active')?.getAttribute('href') || path;
  const seenKey = `captainfin.operator.seen.${pageKey}`;
  try { localStorage.setItem(seenKey, String(Date.now())); } catch (_) {}

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

  // Customers and claims are one operator workflow. Keep the deep claim URL for
  // compatibility, but expose it as a page tab instead of a separate sidebar app.
  if(path==='/admin/users' || path.startsWith('/admin/customer-claims')){
    insertAfterHeader(tabs([['Customers','/admin/users'],['Claims','/admin/customer-claims']],path));
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

  // Plans are one commercial catalogue even though reseller tiers retain a
  // separate persistence model underneath. Service type tabs keep the operator
  // mental model unified and the create form can progressively expose fields.
  if(path.startsWith('/admin/plans') || path.startsWith('/admin/reseller-tiers')){
    const type=new URLSearchParams(location.search).get('type')||'';
    const active=path.startsWith('/admin/reseller-tiers')?'/admin/reseller-tiers':type?`/admin/plans?type=${encodeURIComponent(type)}`:'/admin/plans';
    insertAfterHeader(tabs([
      ['All plans','/admin/plans'],
      ['Jellyfin','/admin/plans?type=jellyfin'],
      ['Stremio','/admin/plans?type=stremio'],
      ['Bundles','/admin/plans?type=bundle'],
      ['Reseller','/admin/reseller-tiers']
    ],active));
  }

  if(path.startsWith('/admin/payments') || path.startsWith('/admin/provider-mappings')){
    insertAfterHeader(tabs([['Payment setup','/admin/payments'],['Provider mappings','/admin/provider-mappings'],['Billing','/admin/billing']],path));
  }

  if(path.startsWith('/admin/notifications')){
    insertAfterHeader(tabs([['Channels & health','/admin/notifications'],['Events & routing','/admin/notifications/preferences']],path));
  }

  // Compact the operator workflow on Needs Attention even when individual
  // finding renderers evolve independently.
  if(path==='/admin/attention'){
    document.querySelectorAll('form').forEach(form=>{
      const selects=form.querySelectorAll('select');
      if(selects.length>=1 && (form.textContent||'').toLowerCase().includes('note'))form.classList.add('attentionActionGrid');
    });
  }

  // The unread endpoint is deliberately optional. Older deployments and pages
  // continue to work if it is unavailable during a rolling update.
  fetch('/admin/api/operator-state/unread', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.counts) return;
      const hrefByKey = {customers:'/admin/users',resellers:'/admin/reseller-management',attention:'/admin/attention',servers:'/admin/servers',payments:'/admin/payments'};
      for (const [key,countValue] of Object.entries(data.counts)) {
        const count = Number(countValue || 0); if (count <= 0) continue;
        const href = hrefByKey[key]; if (!href) continue;
        const link = [...document.querySelectorAll('.adminTab')].find(a => (a.getAttribute('href') || '').split('?')[0] === href);
        if (!link) continue;
        const serverUpdated = Number(data.updatedAt?.[key] || 0);
        let localSeen = 0;
        try { localSeen = Number(localStorage.getItem(`captainfin.operator.seen.${href}`) || 0); } catch (_) {}
        if (serverUpdated && localSeen >= serverUpdated) continue;
        const badge = document.createElement('span');badge.className='unreadBadge';badge.textContent=count>99?'99+':String(count);badge.setAttribute('aria-label',`${count} unread`);link.appendChild(badge);
      }
    }).catch(() => {});

  // Provide lightweight discoverability on dense admin controls without
  // replacing explicit labels or keyboard focus.
  document.querySelectorAll('[title]:not([data-help])').forEach(el => {
    const value = (el.getAttribute('title') || '').trim();
    if (value.length > 5 && value.length < 180) el.setAttribute('data-help', value);
  });
})();
