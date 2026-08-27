(()=>{
  const SECTION_KEY='adminSidebarCollapsedSections';
  const ACCOUNT_KEY='adminSidebarAccountCollapsed';

  function readSet(key){
    try{return new Set(JSON.parse(localStorage.getItem(key)||'[]'));}
    catch{return new Set();}
  }
  function writeSet(key,set){
    try{localStorage.setItem(key,JSON.stringify([...set]));}catch{}
  }
  function readFlag(key){
    try{return localStorage.getItem(key)==='1';}catch{return false;}
  }
  function writeFlag(key,value){
    try{localStorage.setItem(key,value?'1':'0');}catch{}
  }

  const nav=document.querySelector('.adminTabs');
  if(nav){
    const sections=[...nav.querySelectorAll('details.navSection[data-nav-section]')];
    if(sections.length){
      const collapsed=readSet(SECTION_KEY);

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

      for(const section of sections){
        const key=section.dataset.navSection;
        const summary=section.querySelector(':scope > summary.navSectionLabel');
        if(!summary)continue;

        // A section the operator explicitly collapsed stays collapsed even when
        // it owns the page that just rendered -- the accordion state is a
        // deliberate choice, not just an artifact of which page is active.
        if(collapsed.has(key))section.open=false;

        summary.addEventListener('click',event=>{
          // The compact mobile navigation renders the child links directly and
          // hides these summaries, so preserve the simple horizontal behavior.
          if(window.matchMedia('(max-width:860px)').matches)return;
          event.preventDefault();
          if(section.open){
            section.open=false;
            collapsed.add(key);
            writeSet(SECTION_KEY,collapsed);
            return;
          }
          collapsed.delete(key);
          writeSet(SECTION_KEY,collapsed);
          activateSection(section,{navigate:true});
        });

        // Keep the accordion invariant even when a browser, assistive technology,
        // or another script opens a <details> element without using the click path.
        section.addEventListener('toggle',()=>{
          if(section.open)closeOthers(section);
        });
      }

      const initiallyOpen=sections.find(section=>section.open);
      if(initiallyOpen)closeOthers(initiallyOpen);
    }
  }

  const header=document.querySelector('.adminHeader');
  const actions=document.querySelector('[data-header-actions]');
  const toggle=actions?actions.querySelector('[data-header-actions-toggle]'):null;
  if(header&&actions&&toggle){
    function reserveHeight(){
      if(window.matchMedia('(max-width:860px)').matches)return;
      const height=actions.getBoundingClientRect().height;
      if(height>0)header.style.setProperty('--header-actions-h',`${Math.ceil(height)}px`);
    }
    function setCollapsed(value){
      actions.classList.toggle('collapsed',value);
      toggle.setAttribute('aria-expanded',value?'false':'true');
      toggle.title=value?'Expand account menu':'Collapse account menu';
      toggle.setAttribute('aria-label',toggle.title);
      reserveHeight();
    }
    setCollapsed(readFlag(ACCOUNT_KEY));
    toggle.addEventListener('click',()=>{
      const next=!actions.classList.contains('collapsed');
      setCollapsed(next);
      writeFlag(ACCOUNT_KEY,next);
    });
    let resizeTimer=null;
    window.addEventListener('resize',()=>{
      clearTimeout(resizeTimer);
      resizeTimer=setTimeout(reserveHeight,120);
    });
  }
})();
