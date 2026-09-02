'use strict';

(()=>{
  const SECTION_KEY='adminRailOpenSection';
  const LEGACY_SECTION_KEY='adminSidebarCollapsedSections';
  const MOBILE_QUERY='(max-width:820px)';

  function readValue(key){
    try{return localStorage.getItem(key)||'';}catch{return'';}
  }

  function writeValue(key,value){
    try{
      if(value)localStorage.setItem(key,value);
      else localStorage.removeItem(key);
    }catch{}
  }

  function legacyCollapsed(){
    try{return new Set(JSON.parse(localStorage.getItem(LEGACY_SECTION_KEY)||'[]'));}
    catch{return new Set();}
  }

  const header=document.querySelector('.adminHeader');
  const nav=header?.querySelector('.adminTabs');
  const tabsWrap=header?.querySelector('.adminTabsWrap');
  if(!header||!nav||!tabsWrap)return;

  const sections=[...nav.querySelectorAll('details.navSection[data-nav-section]')];
  const activeSection=sections.find(section=>section.classList.contains('active'))||sections.find(section=>section.open)||sections[0]||null;

  // Legacy EJS screens cannot publish data-section on <body> without touching
  // their page bodies. Derive it from the same canonical rail registry instead.
  if(!document.body.dataset.section&&activeSection?.dataset.navSection){
    document.body.dataset.section=activeSection.dataset.navSection;
  }

  let syncing=false;
  function closeOthers(section){
    syncing=true;
    for(const other of sections){
      if(other!==section&&other.open)other.open=false;
    }
    syncing=false;
  }

  function persistSection(section){
    writeValue(SECTION_KEY,section?.open?section.dataset.navSection:'');
  }

  if(sections.length){
    const stored=readValue(SECTION_KEY);
    const storedSection=sections.find(section=>section.dataset.navSection===stored);
    const legacy=legacyCollapsed();
    const initial=storedSection||(activeSection&&!legacy.has(activeSection.dataset.navSection)?activeSection:null);

    syncing=true;
    for(const section of sections)section.open=section===initial;
    syncing=false;

    for(const section of sections){
      const summary=section.querySelector(':scope > summary.navSectionLabel');
      if(summary)summary.setAttribute('aria-expanded',section.open?'true':'false');
      section.addEventListener('toggle',()=>{
        if(syncing)return;
        if(section.open){
          closeOthers(section);
          persistSection(section);
        }else if(!sections.some(other=>other.open)){
          persistSection(null);
        }
        for(const other of sections){
          const otherSummary=other.querySelector(':scope > summary.navSectionLabel');
          if(otherSummary)otherSummary.setAttribute('aria-expanded',other.open?'true':'false');
        }
      });
    }
  }

  const topBar=document.querySelector('.topBar');
  const mobile=window.matchMedia(MOBILE_QUERY);
  if(!tabsWrap.id)tabsWrap.id='adminRailNavigation';

  let toggle=document.querySelector('[data-admin-mobile-nav-toggle]');
  if(!toggle&&topBar){
    toggle=document.createElement('button');
    toggle.type='button';
    toggle.className='adminMobileNavToggle';
    toggle.setAttribute('data-admin-mobile-nav-toggle','');
    toggle.setAttribute('aria-controls',tabsWrap.id);
    toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-label','Open administration menu');
    toggle.innerHTML='<span class="adminMobileNavGlyph" aria-hidden="true">☰</span><span class="adminMobileNavLabel">Menu</span>';
    topBar.prepend(toggle);
  }

  let backdrop=document.querySelector('[data-admin-mobile-nav-backdrop]');
  if(!backdrop){
    backdrop=document.createElement('div');
    backdrop.className='adminMobileNavBackdrop';
    backdrop.setAttribute('data-admin-mobile-nav-backdrop','');
    backdrop.hidden=true;
    document.body.appendChild(backdrop);
  }

  function focusableInDrawer(){
    return [...header.querySelectorAll('a[href],button:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
      .filter(element=>!element.hasAttribute('hidden')&&element.getAttribute('aria-hidden')!=='true'&&element.getClientRects().length>0);
  }

  function drawerIsOpen(){return mobile.matches&&header.classList.contains('mobileNavOpen');}

  function setDrawerOpen(open,{restoreFocus=false}={}){
    const next=Boolean(open&&mobile.matches&&toggle);
    header.classList.toggle('mobileNavOpen',next);
    document.body.classList.toggle('mobileNavLocked',next);
    backdrop.hidden=!next;
    if(toggle){
      toggle.setAttribute('aria-expanded',next?'true':'false');
      toggle.setAttribute('aria-label',next?'Close administration menu':'Open administration menu');
    }

    if(next){
      const current=header.querySelector('.adminTab[aria-current="page"]')
        ||header.querySelector('.navSection.active > summary')
        ||focusableInDrawer()[0];
      current?.focus({preventScroll:true});
    }else if(restoreFocus){
      toggle?.focus({preventScroll:true});
    }
  }

  toggle?.addEventListener('click',()=>{
    const wasOpen=drawerIsOpen();
    setDrawerOpen(!wasOpen,{restoreFocus:wasOpen});
  });
  backdrop.addEventListener('click',()=>setDrawerOpen(false,{restoreFocus:true}));
  header.addEventListener('click',event=>{
    if(drawerIsOpen()&&event.target.closest('a[href]'))setDrawerOpen(false);
  });

  document.addEventListener('keydown',event=>{
    if(!drawerIsOpen())return;
    if(event.key==='Escape'){
      event.preventDefault();
      setDrawerOpen(false,{restoreFocus:true});
      return;
    }
    if(event.key!=='Tab')return;
    const focusable=focusableInDrawer();
    if(!focusable.length){
      event.preventDefault();
      return;
    }
    const first=focusable[0];
    const last=focusable[focusable.length-1];
    if(event.shiftKey&&document.activeElement===first){
      event.preventDefault();
      last.focus();
    }else if(!event.shiftKey&&document.activeElement===last){
      event.preventDefault();
      first.focus();
    }else if(!header.contains(document.activeElement)){
      event.preventDefault();
      first.focus();
    }
  });

  const viewportChanged=()=>{
    if(!mobile.matches)setDrawerOpen(false);
  };
  if(typeof mobile.addEventListener==='function')mobile.addEventListener('change',viewportChanged);
  else if(typeof mobile.addListener==='function')mobile.addListener(viewportChanged);
})();
