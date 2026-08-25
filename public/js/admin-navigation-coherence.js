'use strict';

(() => {
  const path=location.pathname;

  // The left sidebar is the single navigation hierarchy. This enhancer is now
  // only a cleanup safety net for legacy pages that may still emit historical
  // workflow/tab navigation in their page body.
  function enforceSidebarOnlyNavigation(){
    const content=document.querySelector('.content');
    if(!content)return;
    content.querySelectorAll(
      'nav.workflowCardGrid.operatorTabs,nav.coherenceSectionTabs,nav.coherenceSubTabs,section.coherenceOwnedTools'
    ).forEach(node=>node.remove());
  }

  enforceSidebarOnlyNavigation();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();
