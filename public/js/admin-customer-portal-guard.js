'use strict';

(() => {
  const path=location.pathname.replace(/\/+$/,'')||'/';
  if(!/^\/admin\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path))return;

  const grid=document.querySelector('[data-customer-primary-actions] .customerActionGrid');
  const portal=grid?.querySelector('[data-customer-portal-primary="1"]');
  if(!grid||!portal)return;

  const template=portal.cloneNode(true);
  const restore=()=>{
    if(grid.querySelector('[data-customer-portal-primary="1"]'))return;
    grid.insertBefore(template.cloneNode(true),grid.firstChild);
  };

  // Observe only direct action-grid membership. Legacy admin enhancements may
  // still clean up or relocate forms after first paint; the canonical portal
  // tile must remain in Customer Actions regardless of those enhancements.
  const observer=new MutationObserver(restore);
  observer.observe(grid,{childList:true});
  restore();
})();
