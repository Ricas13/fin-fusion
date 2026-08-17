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

  const match=location.pathname.match(/^\/admin\/plans\/([^/]+)\/(edit|delivery|inventory|commerce|jellyfin|libraries|placement|lifecycle|payment-options|archive-confirm)$/);
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
  const deliveryPages=['delivery','jellyfin','libraries','placement','lifecycle'];
  const active=(page==='edit'||page==='archive-confirm')?'overview':deliveryPages.includes(page)?'delivery':page==='inventory'?'availability':'commerce';
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

  const jellyfinTools=()=>{
    const tools=document.createElement('div');tools.className='buttonRow planDeliveryTools';tools.setAttribute('aria-label','Jellyfin delivery settings');
    [
      ['Playback policy',`/admin/plans/${id}/jellyfin`,'jellyfin'],
      ['Libraries',`/admin/plans/${id}/libraries`,'libraries'],
      ['Server placement',`/admin/plans/${id}/placement`,'placement'],
      ['Lifecycle',`/admin/plans/${id}/lifecycle`,'lifecycle']
    ].forEach(([label,href,key])=>{const a=document.createElement('a');a.className=`button btn-sm ${page===key?'':'secondary'}`;a.href=href;a.textContent=label;tools.appendChild(a);});
    return tools;
  };

  // Deep Jellyfin pages are subordinate to Delivery. The normal Stremio-only
  // workflow never links to them, but compatibility deep links remain usable.
  if(['jellyfin','libraries','placement','lifecycle'].includes(page))top.insertAdjacentElement('afterend',jellyfinTools());

  // On the Delivery landing page the selected service type tells us whether a
  // normal Jellyfin identity is part of the product. Only then expose its tools.
  if(page==='delivery'){
    const selected=document.querySelector('input[name="serviceType"]:checked')?.value;
    if(selected==='jellyfin'||selected==='bundle')top.insertAdjacentElement('afterend',jellyfinTools());
    document.querySelectorAll('input[name="serviceType"]').forEach(input=>input.addEventListener('change',()=>{
      document.querySelector('.planDeliveryTools')?.remove();
      if(input.checked&&(input.value==='jellyfin'||input.value==='bundle'))top.insertAdjacentElement('afterend',jellyfinTools());
    }));
  }
})();
