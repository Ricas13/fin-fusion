(()=>{
  const nav=document.querySelector('.adminTabs');
  const drawer=document.querySelector('[data-admin-navigation]');
  if(!nav||!drawer)return;

  const sections=[...nav.querySelectorAll('details.navSection[data-nav-section]')];
  const mobileQuery=window.matchMedia('(max-width:860px)');
  const openButton=document.querySelector('[data-admin-nav-open]');
  const backdrop=document.querySelector('.adminNavBackdrop[data-admin-nav-close]');
  const closeButtons=[...document.querySelectorAll('[data-admin-nav-close]')];
  let returnFocus=null;

  function closeOthers(section){
    for(const other of sections){
      if(other!==section&&other.open)other.open=false;
    }
  }

  function firstDestination(section){
    return section.querySelector('.navSectionPages .adminTab[href]');
  }

  function sameDestination(anchor){
    if(!anchor)return true;
    try{
      const current=new URL(window.location.href);
      const target=new URL(anchor.href,window.location.href);
      return current.pathname===target.pathname&&current.search===target.search&&current.hash===target.hash;
    }catch{
      return false;
    }
  }

  function activateSection(section,{navigate=true}={}){
    closeOthers(section);
    section.open=true;
    if(!navigate)return;
    const first=firstDestination(section);
    if(first&&!sameDestination(first))window.location.assign(first.href);
  }

  function drawerOpen(){
    return document.body.classList.contains('adminNavOpen');
  }

  function setDrawerAccessible(open){
    if(!mobileQuery.matches){
      drawer.removeAttribute('aria-hidden');
      drawer.removeAttribute('inert');
      return;
    }
    drawer.setAttribute('aria-hidden',open?'false':'true');
    if(open)drawer.removeAttribute('inert');
    else drawer.setAttribute('inert','');
  }

  function openDrawer(){
    if(!mobileQuery.matches)return;
    returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:openButton;
    document.body.classList.add('adminNavOpen');
    drawer.classList.add('isMobileOpen');
    if(backdrop)backdrop.hidden=false;
    openButton?.setAttribute('aria-expanded','true');
    setDrawerAccessible(true);
    const target=drawer.querySelector('.adminTab[aria-current="page"]')||drawer.querySelector('.navSection.active > .navSectionLabel')||drawer.querySelector('[data-admin-nav-close]');
    window.requestAnimationFrame(()=>target?.focus?.());
  }

  function closeDrawer({restoreFocus=true}={}){
    document.body.classList.remove('adminNavOpen');
    drawer.classList.remove('isMobileOpen');
    if(backdrop)backdrop.hidden=true;
    openButton?.setAttribute('aria-expanded','false');
    setDrawerAccessible(false);
    if(restoreFocus&&mobileQuery.matches&&returnFocus?.focus)window.requestAnimationFrame(()=>returnFocus.focus());
    returnFocus=null;
  }

  function syncViewport(){
    if(mobileQuery.matches){
      if(!drawerOpen()){
        if(backdrop)backdrop.hidden=true;
        openButton?.setAttribute('aria-expanded','false');
        setDrawerAccessible(false);
      }
      return;
    }
    closeDrawer({restoreFocus:false});
    setDrawerAccessible(false);
  }

  for(const section of sections){
    const summary=section.querySelector(':scope > summary.navSectionLabel');
    if(!summary)continue;

    summary.addEventListener('click',event=>{
      // On phones the sidebar is a drawer. Keep the group label as a real
      // disclosure control so every section can be browsed without navigating.
      if(mobileQuery.matches)return;
      event.preventDefault();
      activateSection(section,{navigate:true});
    });

    section.addEventListener('toggle',()=>{
      if(section.open)closeOthers(section);
    });
  }

  openButton?.addEventListener('click',openDrawer);
  for(const button of closeButtons)button.addEventListener('click',()=>closeDrawer());
  nav.addEventListener('click',event=>{
    if(mobileQuery.matches&&event.target.closest('.adminTab[href]'))closeDrawer({restoreFocus:false});
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&mobileQuery.matches&&drawerOpen()){
      event.preventDefault();
      closeDrawer();
    }
  });

  const initiallyOpen=sections.find(section=>section.open);
  if(initiallyOpen)closeOthers(initiallyOpen);
  if(typeof mobileQuery.addEventListener==='function')mobileQuery.addEventListener('change',syncViewport);
  else mobileQuery.addListener?.(syncViewport);
  syncViewport();
})();
