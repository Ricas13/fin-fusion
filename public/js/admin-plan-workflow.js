'use strict';

(() => {
  if(location.pathname==='/admin/plans'){
    // The list is an entry point, not a second copy of the plan workflow.
    // Manage opens the plan; Availability remains linked from the capacity cell.
    // Delivery/Lifecycle shortcuts created an arbitrary mix of destinations.
    document.querySelectorAll('.planListRow .buttonRow a[href]').forEach(link=>{
      const href=link.getAttribute('href')||'';
      if(/\/delivery$|\/lifecycle$/.test(href))link.remove();
    });
    return;
  }

  // The Jellyfin delivery pages (jellyfin/libraries/placement/lifecycle) are
  // now legacy URLs that redirect server-side into this unified /edit page's
  // own cards, so they can never be the page actually loaded here anymore.
  const match=location.pathname.match(/^\/admin\/plans\/([^/]+)\/(edit|delivery|inventory|commerce|payment-options|archive-confirm)$/);
  if(!match)return;
  const id=match[1],page=match[2];
  const header=document.querySelector('.pageHeader');
  if(!header)return;

  if(!document.querySelector('link[data-plan-workflow-style]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href='/css/admin-plan-workflow.css';link.dataset.planWorkflowStyle='true';document.head.appendChild(link);
  }
  document.querySelectorAll('.planSubnav').forEach(node=>node.remove());

  const topItems=[
    ['Overview',`/admin/plans/${id}/edit`,'overview'],
    ['Delivery',`/admin/plans/${id}/delivery`,'delivery'],
    ['Availability',`/admin/plans/${id}/inventory`,'availability'],
    ['Commerce',`/admin/plans/${id}/commerce`,'commerce']
  ];
  const active=(page==='edit'||page==='archive-confirm')?'overview':page==='delivery'?'delivery':page==='inventory'?'availability':'commerce';
  const top=document.createElement('nav');top.className='operatorTabs planWorkflowTabs';top.setAttribute('aria-label','Plan management');
  topItems.forEach(([label,href,key])=>{const a=document.createElement('a');a.className=`operatorTab ${key===active?'active':''}`;a.href=href;a.textContent=label;top.appendChild(a);});
  header.insertAdjacentElement('afterend',top);

  // Back links became redundant once every plan page shares a stable workflow.
  document.querySelectorAll('.topBarActions a[href]').forEach(link=>{
    const href=link.getAttribute('href')||'';
    if(href==='/admin/plans'||href===`/admin/plans/${id}/edit`)link.remove();
  });
  document.querySelectorAll('.sectionHead a.button[href],.card-header a.button[href]').forEach(link=>{
    const href=link.getAttribute('href')||'';
    if(href===`/admin/plans/${id}/edit` && /back to plan/i.test(link.textContent||''))link.remove();
  });
})();
