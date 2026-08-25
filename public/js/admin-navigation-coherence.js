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

  enforceSidebarOnlyNavigation();
  movePageActionsToHeading();
  watchLatePageActions();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();
