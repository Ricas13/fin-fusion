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
  function callout(html,kind=''){
    const div=document.createElement('div');div.className=`operatorCallout ${kind}`;div.innerHTML=html;return div;
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

  // Catalogue filters belong only to catalogue browsing / new-product selection.
  // Individual plan settings render their own service-aware management workflow
  // server-side, so adding this row there created competing navigation systems.
  const planCataloguePage=path==='/admin/plans' || path==='/admin/plans/new' || path.startsWith('/admin/reseller-tiers');
  if(planCataloguePage){
    const type=new URLSearchParams(location.search).get('type')||'';
    const active=path.startsWith('/admin/reseller-tiers')?'/admin/reseller-tiers':type?`/admin/plans?type=${encodeURIComponent(type)}`:'/admin/plans';
    insertAfterHeader(tabs([
      ['All plans','/admin/plans'],
      ['Jellyfin','/admin/plans?type=jellyfin'],
      ['Stremio','/admin/plans?type=stremio'],
      ['Bundles','/admin/plans?type=bundle'],
      ['Reseller','/admin/reseller-tiers']
    ],active));
    // Old reseller-tier forms accepted an arbitrary three-letter code. Keep the
    // backend compatibility but constrain the operator UI to the three supported
    // commercial currencies.
    if(path.startsWith('/admin/reseller-tiers')){
      document.querySelectorAll('input[name="currency"]').forEach(input=>{
        const select=document.createElement('select');select.className=input.className||'input';select.name='currency';
        ['GBP','USD','EUR'].forEach(code=>{const option=document.createElement('option');option.value=code;option.textContent=code;if(String(input.value||'GBP').toUpperCase()===code)option.selected=true;select.appendChild(option);});
        input.replaceWith(select);
      });
    }
  }

  // Payments, Notifications, Provisioning and Backups/Transfer now render their
  // workflow navigation server-side. Do not add a second client-side tab row.
  if(path==='/admin/notifications/preferences'){
    // Top workflow tabs own navigation now; avoid repeating those destinations
    // inside the status row. The profile link remains available in the explanatory callout.
    document.querySelectorAll('.buttonRow a[href="/admin/email"],.buttonRow a[href="/admin/profile/notifications"]').forEach(link=>link.remove());
    // Legacy global destinations are retained for explicit manual/test callers,
    // but normal event fan-out uses per-admin/per-customer identities. Keep the
    // compatibility values without presenting them as required setup fields.
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
    const info=callout('<strong>Where do the actual stream limits come from?</strong> Customer concurrency and delivery limits come from the customer’s <a href="/admin/plans">plan</a>. This page chooses what CAPTaINFiN does when live Jellyfin activity exceeds those effective limits: Observe, Warn or Enforce. <a href="/admin/activity/inactivity-policy">Free-user inactivity rules are configured separately.</a>','');
    if(banner)banner.insertAdjacentElement('afterend',info);else insertAfterHeader(info);
  }
  if(path.startsWith('/admin/activity/inactivity-policy')){
    insertAfterHeader(tabs([['Live playback','/admin/activity'],['Inactivity rules','/admin/activity/inactivity-policy']],path));
  }

  // Compact the operator workflow on Needs Attention even when individual
  // finding renderers evolve independently.
  if(path==='/admin/attention'){
    document.querySelectorAll('form').forEach(form=>{
      const selects=form.querySelectorAll('select');
      if(selects.length>=1 && (form.textContent||'').toLowerCase().includes('note'))form.classList.add('attentionActionGrid');
    });
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-copy-value]');if(!button)return;
    const value=button.getAttribute('data-copy-value')||'';
    navigator.clipboard?.writeText(value).then(()=>{const old=button.textContent;button.textContent='Copied';setTimeout(()=>button.textContent=old,1200);}).catch(()=>{});
  });

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
