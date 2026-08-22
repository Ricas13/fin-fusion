(()=>{
  const nav=document.querySelector('.adminTabs');
  if(!nav)return;

  const sections=[...nav.querySelectorAll('details.navSection[data-nav-section]')];
  if(!sections.length)return;

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
    const summary=section.querySelector(':scope > summary.navSectionLabel');
    if(!summary)continue;

    summary.addEventListener('click',event=>{
      // The compact mobile navigation renders the child links directly and
      // hides these summaries, so preserve the simple horizontal behavior.
      if(window.matchMedia('(max-width:860px)').matches)return;
      event.preventDefault();
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
})();
