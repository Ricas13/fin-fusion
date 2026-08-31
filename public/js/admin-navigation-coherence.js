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

  function installMobileAdminDrawer(){
    const header=document.querySelector('.adminHeader');
    const headerMain=header?.querySelector('.headerMain');
    const tabsWrap=header?.querySelector('.adminTabsWrap');
    const nav=tabsWrap?.querySelector('.adminTabs');
    const account=header?.querySelector('[data-header-actions]');
    if(!header||!headerMain||!tabsWrap||!nav)return;

    const mobile=window.matchMedia('(max-width:860px)');
    if(!tabsWrap.id)tabsWrap.id='adminMobileNavigation';

    const accountHome=account?.parentNode||null;
    const accountNext=account?.nextSibling||null;
    function placeAccountMenu(){
      if(!account||!accountHome)return;
      if(mobile.matches){
        if(account.parentNode!==tabsWrap)tabsWrap.appendChild(account);
      }else if(account.parentNode!==accountHome){
        if(accountNext&&accountNext.parentNode===accountHome)accountHome.insertBefore(account,accountNext);
        else accountHome.appendChild(account);
      }
    }

    let toggle=headerMain.querySelector('[data-admin-mobile-nav-toggle]');
    if(!toggle){
      toggle=document.createElement('button');
      toggle.type='button';
      toggle.className='adminMobileNavToggle';
      toggle.setAttribute('data-admin-mobile-nav-toggle','');
      toggle.setAttribute('aria-controls',tabsWrap.id);
      toggle.setAttribute('aria-expanded','false');
      toggle.setAttribute('aria-label','Open administration menu');
      toggle.innerHTML='<span class="adminMobileNavGlyph" aria-hidden="true">☰</span><span>Menu</span>';
      headerMain.appendChild(toggle);
    }

    let backdrop=document.querySelector('[data-admin-mobile-nav-backdrop]');
    if(!backdrop){
      backdrop=document.createElement('div');
      backdrop.className='adminMobileNavBackdrop';
      backdrop.setAttribute('data-admin-mobile-nav-backdrop','');
      backdrop.hidden=true;
      document.body.appendChild(backdrop);
    }

    const sections=[...nav.querySelectorAll('details.navSection')];
    function closeOtherSections(opened){
      for(const section of sections){
        if(section!==opened&&section.open)section.open=false;
      }
    }
    for(const section of sections){
      section.addEventListener('toggle',()=>{
        if(section.open)closeOtherSections(section);
      });
    }

    function setOpen(open,{restoreFocus=false}={}){
      placeAccountMenu();
      const next=Boolean(open&&mobile.matches);
      header.classList.toggle('mobileNavOpen',next);
      document.body.classList.toggle('mobileNavLocked',next);
      toggle.setAttribute('aria-expanded',next?'true':'false');
      toggle.setAttribute('aria-label',next?'Close administration menu':'Open administration menu');
      backdrop.hidden=!next;
      if(next){
        // Keep the active destination visible, but do not prevent the drawer
        // itself from scrolling when a large section such as Commerce expands.
        const active=nav.querySelector('.adminSubTab.active,.adminTab.active,.navSectionLabel');
        if(active&&typeof active.focus==='function')active.focus({preventScroll:true});
      }else if(restoreFocus&&typeof toggle.focus==='function')toggle.focus({preventScroll:true});
    }

    toggle.addEventListener('click',()=>setOpen(!header.classList.contains('mobileNavOpen')));
    backdrop.addEventListener('click',()=>setOpen(false,{restoreFocus:true}));
    tabsWrap.addEventListener('click',event=>{
      if(event.target.closest('a[href]'))setOpen(false);
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&header.classList.contains('mobileNavOpen'))setOpen(false,{restoreFocus:true});
    });
    const onViewportChange=()=>{
      placeAccountMenu();
      if(!mobile.matches)setOpen(false);
    };
    placeAccountMenu();
    if(typeof mobile.addEventListener==='function')mobile.addEventListener('change',onViewportChange);
    else if(typeof mobile.addListener==='function')mobile.addListener(onViewportChange);
  }

  function loadSettingsGroups(){
    if(document.querySelector('script[data-admin-settings-groups]'))return;
    const script=document.createElement('script');
    script.src='/js/admin-settings-groups.js';
    script.defer=true;
    script.setAttribute('data-admin-settings-groups','');
    document.head.appendChild(script);
  }

  enforceSidebarOnlyNavigation();
  movePageActionsToHeading();
  watchLatePageActions();
  installCustomerBillingActions();
  installBackupExportAction();
  installMobileAdminDrawer();
  loadSettingsGroups();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();
