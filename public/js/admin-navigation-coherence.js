'use strict';

(() => {
  const path=location.pathname;
  const search=new URLSearchParams(location.search);

  // Legacy audit vocabulary retained for compatibility: Settings sections,
  // Commerce sections and Playback sections. Only the first/owning section row
  // is rendered now; specialist destinations live in the canonical sidebar.
  function current(href,group){
    const target=new URL(href,location.origin);
    if(group==='settings'){
      const section=search.get('section')||'';
      if(target.pathname==='/admin/system')return path==='/admin/system';
      if(target.pathname==='/admin/settings/integrations')return path==='/admin/settings/integrations'||path==='/admin/settings'&&section==='integrations'||path.startsWith('/admin/notifications')||path==='/admin/request-users';
      if(target.pathname==='/admin/settings/commerce')return path==='/admin/settings/commerce';
      if(target.searchParams.get('section')==='general')return path==='/admin/settings'&&(!section||section==='general')||['/admin/settings/branding','/admin/settings/support','/admin/setup'].some(prefix=>path.startsWith(prefix));
      if(target.searchParams.get('section')==='security')return path==='/admin/settings'&&section==='security'||path.startsWith('/admin/settings/admin-2fa')||path.startsWith('/admin/settings/abuse-protection')||path==='/admin/security';
    }
    if(group==='jellyfin'){
      if(target.pathname==='/admin/servers')return path==='/admin/servers'||path.startsWith('/admin/servers/')&&!path.startsWith('/admin/servers/stremio')||path==='/admin/libraries';
      if(target.pathname==='/admin/activity')return path==='/admin/activity'||path.startsWith('/admin/activity/');
    }
    return path===target.pathname||path.startsWith(target.pathname.endsWith('/')?target.pathname:target.pathname+'/');
  }

  function fallbackNav(items,{label='Section navigation',group=''}={}){
    const el=document.createElement('nav');
    el.className='workflowCardGrid coherenceSectionTabs';
    el.setAttribute('aria-label',label);
    items.forEach(([text,href])=>{
      const selected=current(href,group);
      const a=document.createElement('a');
      a.className=`workflowCard coherenceSectionTab${selected?' active':''}`;
      a.href=href;
      if(selected)a.setAttribute('aria-current','page');
      const eyebrow=document.createElement('span');eyebrow.className='workflowCardEyebrow';eyebrow.textContent=selected?'Current':'Related';
      const title=document.createElement('strong');title.textContent=text;
      a.append(eyebrow,title);el.appendChild(a);
    });
    return el;
  }

  function insertFallback(node){
    if(document.querySelector('.coherenceSectionTabs'))return;
    const header=document.querySelector('.pageHeader');
    if(header?.parentNode)header.insertAdjacentElement('afterend',node);
  }

  // Modern pages already receive their one primary row from the server. Legacy
  // EJS pages get the exact same Current/Related treatment here, but never a
  // second subsection row.
  if(!document.querySelector('.coherenceSectionTabs')){
    const settingsOwned=path.startsWith('/admin/settings')||path==='/admin/system'||path==='/admin/security'||path==='/admin/setup'||path.startsWith('/admin/notifications')||path==='/admin/request-users';
    if(settingsOwned){
      insertFallback(fallbackNav([
        ['General','/admin/settings?section=general'],
        ['Security','/admin/settings?section=security'],
        ['Connections','/admin/settings/integrations'],
        ['Commerce','/admin/settings/commerce'],
        ['System','/admin/system']
      ],{label:'Settings sections',group:'settings'}));
    }

    const jellyfinOwned=path==='/admin/servers'||path.startsWith('/admin/servers/')&&!path.startsWith('/admin/servers/stremio')||path==='/admin/libraries'||path==='/admin/activity'||path.startsWith('/admin/activity/');
    if(jellyfinOwned){
      insertFallback(fallbackNav([
        ['Servers','/admin/servers'],
        ['Playback','/admin/activity']
      ],{label:'Jellyfin sections',group:'jellyfin'}));
    }
  }

  function normalizedNavHref(link){
    try{
      const target=new URL(link.getAttribute('href')||'',location.origin);
      return `${target.pathname}${target.search}${target.hash}`;
    }catch(_){return'';}
  }

  function upperCandidates(content){
    const children=[...content.children];
    const headerIndex=children.findIndex(node=>node.classList?.contains('pageHeader'));
    if(headerIndex<0)return[];
    const result=[];
    for(let i=headerIndex+1;i<children.length;i++){
      const node=children[i];
      const isNav=node.matches?.('.workflowCardGrid,.operatorTabs,.coherenceSubTabs,.coherenceSectionTabs');
      if(isNav){result.push(node);continue;}
      if(node.matches?.('script,link,.notice.widgetHidden'))continue;
      break;
    }
    return result;
  }

  function promotePrimary(candidate){
    if(!candidate)return null;
    candidate.classList.add('workflowCardGrid','coherenceSectionTabs');
    candidate.classList.remove('coherenceSubTabs');
    candidate.querySelectorAll('a[href]').forEach(link=>{
      const selected=normalizedNavHref(link)===`${location.pathname}${location.search}${location.hash}`||link.classList.contains('active');
      link.classList.add('workflowCard','coherenceSectionTab');
      link.classList.remove('operatorTab','coherenceSubTab');
      let eyebrow=link.querySelector('.workflowCardEyebrow');
      if(!eyebrow){
        eyebrow=document.createElement('span');eyebrow.className='workflowCardEyebrow';link.prepend(eyebrow);
      }
      eyebrow.textContent=selected?'Current':'Related';
      if(!link.querySelector(':scope > strong')){
        const text=[...link.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim();
        [...link.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).forEach(node=>node.remove());
        const strong=document.createElement('strong');strong.textContent=text||link.textContent.trim();link.appendChild(strong);
      }
    });
    return candidate;
  }

  function enforceSingleUpperNavigation(){
    const content=document.querySelector('.content');
    if(!content)return;
    let candidates=upperCandidates(content);
    let primary=candidates.find(node=>node.classList.contains('coherenceSectionTabs'))||null;
    if(!primary){
      const preferred=candidates.find(node=>node.classList.contains('workflowCardGrid'))||candidates[0]||null;
      primary=promotePrimary(preferred);
      candidates=upperCandidates(content);
    }
    for(const candidate of candidates){
      if(candidate!==primary)candidate.remove();
    }
    // Late legacy subtab rows are invalid too. Their destinations are already
    // available from the shared sidebar, so remove them instead of creating a
    // second hidden navigation directory at the bottom of the page.
    content.querySelectorAll('.coherenceSubTabs,.coherenceOwnedTools').forEach(candidate=>candidate.remove());
  }

  enforceSingleUpperNavigation();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();
