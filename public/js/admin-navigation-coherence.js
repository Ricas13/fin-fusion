'use strict';

(() => {
  const path=location.pathname;

  // The left sidebar is the single navigation hierarchy. This enhancer is now
  // only a cleanup safety net for legacy pages and client enhancers that may
  // still emit historical workflow/tab navigation inside page content.
  function enforceSidebarOnlyNavigation(){
    const content=document.querySelector('.content');
    if(!content)return;
    content.querySelectorAll(
      'nav.workflowCardGrid,nav.operatorTabs,nav.coherenceSectionTabs,nav.coherenceSubTabs,section.coherenceOwnedTools'
    ).forEach(node=>node.remove());
  }

  // The top bar is reserved for global utilities (search, status, help and
  // read-only header metrics). Page-scoped controls belong next to the page
  // heading so Add/Edit/Import/Export actions are visibly tied to their page.
  // Moving the existing nodes preserves forms, CSRF inputs, handlers and links.
  function movePageActionsToHeading(){
    const topActions=document.querySelector('.topBarActions');
    const pageHeader=document.querySelector('.content > .pageHeader')||document.querySelector('.pageHeader');
    if(!topActions||!pageHeader)return;

    const utilitySelector='.topStatusWrap,.topHelpLink,.topHeaderMetrics';
    const actions=[...topActions.children].filter(node=>!node.matches(utilitySelector));
    if(!actions.length)return;

    let target=pageHeader.querySelector(':scope > .pageHeaderActions');
    if(!target){
      target=document.createElement('div');
      target.className='pageHeaderActions';
      target.setAttribute('aria-label','Page actions');
      pageHeader.appendChild(target);
    }
    actions.forEach(node=>target.appendChild(node));
  }

  function watchLatePageActions(){
    const topActions=document.querySelector('.topBarActions');
    if(!topActions||typeof MutationObserver!=='function')return;
    const observer=new MutationObserver(mutations=>{
      if(mutations.some(mutation=>mutation.type==='childList'&&mutation.addedNodes.length))movePageActionsToHeading();
    });
    observer.observe(topActions,{childList:true});
  }

  function pageAction(label,href,marker){
    const pageHeader=document.querySelector('.content > .pageHeader')||document.querySelector('.pageHeader');
    if(!pageHeader||pageHeader.querySelector(`[${marker}]`))return;
    let actions=pageHeader.querySelector(':scope > .pageHeaderActions');
    if(!actions){
      actions=document.createElement('div');
      actions.className='pageHeaderActions';
      actions.setAttribute('aria-label','Page actions');
      pageHeader.appendChild(actions);
    }
    const link=document.createElement('a');
    link.className='button secondary';
    link.href=href;
    link.textContent=label;
    link.setAttribute(marker,'');
    actions.appendChild(link);
  }

  // Prepaid refunds are intentionally not permanent sidebar navigation. They
  // are a customer support action, so expose the specialist workflow only from
  // the customer's Billing context and pre-filter it to that customer.
  function installCustomerBillingActions(){
    const match=path.match(/^\/admin\/users\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if(!match||new URLSearchParams(location.search).get('tab')!=='billing')return;
    pageAction('Prepaid refund',`/admin/refunds?customerId=${encodeURIComponent(match[1])}`,'data-prepaid-refund-action');
  }

  function installBackupExportAction(){
    if(path!=='/admin/backups')return;
    pageAction('Export data','/admin/payments/export','data-backup-export-action');
  }

  function loadScript(src,marker){
    if(document.querySelector(`script[${marker}]`))return;
    const script=document.createElement('script');
    script.src=src;
    script.defer=true;
    script.setAttribute(marker,'');
    document.head.appendChild(script);
  }

  function loadSettingsGroups(){
    if(document.querySelector('script[data-admin-settings-groups]'))return;
    const script=document.createElement('script');
    script.src='/js/admin-settings-groups.js';
    script.defer=true;
    script.setAttribute('data-admin-settings-groups','');
    document.head.appendChild(script);
  }

  function loadPlanAccessEnhancer(){
    if(!/^\/admin\/plans\/[0-9a-f-]{36}\/(?:edit|access|jellyfin)$/i.test(path))return;
    loadScript('/js/admin-plan-access.js','data-admin-plan-access');
  }

  enforceSidebarOnlyNavigation();
  movePageActionsToHeading();
  watchLatePageActions();
  installCustomerBillingActions();
  installBackupExportAction();
  loadSettingsGroups();
  loadPlanAccessEnhancer();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();