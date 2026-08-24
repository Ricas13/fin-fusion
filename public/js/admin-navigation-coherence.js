'use strict';

(() => {
  const path=location.pathname;
  const search=new URLSearchParams(location.search);

  // Compatibility labels consumed by the legacy coherence audit. The modern
  // renderer owns Settings sections and Commerce sections; this fallback owns
  // the remaining legacy-EJS Jellyfin / Playback sections only when needed.

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

  function fallbackNav(items,{label='Section navigation',group='',sub=false}={}){
    const el=document.createElement('nav');
    el.className=sub?'coherenceSubTabs':'coherenceSectionTabs';
    el.setAttribute('aria-label',label);
    items.forEach(([text,href])=>{
      const a=document.createElement('a');
      a.className=sub?'coherenceSubTab':'coherenceSectionTab';
      a.href=href;
      a.textContent=text;
      const selected=sub
        ? (href.includes('#playback-policy')?location.hash==='#playback-policy':path===new URL(href,location.origin).pathname&&location.hash!=='#playback-policy')
        : current(href,group);
      if(selected){a.classList.add('active');a.setAttribute('aria-current','page');}
      el.appendChild(a);
    });
    return el;
  }

  function insertFallback(node,sub=false){
    if(document.querySelector(sub?'.coherenceSubTabs':'.coherenceSectionTabs'))return;
    const primary=document.querySelector('.coherenceSectionTabs');
    const header=document.querySelector('.pageHeader');
    if(sub&&primary)primary.insertAdjacentElement('afterend',node);
    else if(header?.parentNode)header.insertAdjacentElement('afterend',node);
  }

  // Modern admin-html pages already contain both hierarchy rows in their
  // server-rendered HTML. Only the remaining legacy EJS pages reach this path.
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
      if(path==='/admin/activity'||path.startsWith('/admin/activity/')){
        insertFallback(fallbackNav([
          ['Live playback','/admin/activity'],
          ['Policy settings','/admin/activity#playback-policy']
        ],{label:'Playback sections',sub:true}),true);
      }
    }
  }

  function syncPlaybackAnchor(){
    if(path!=='/admin/activity')return;
    document.querySelectorAll('.coherenceSubTab').forEach(link=>{
      const isPolicy=(link.getAttribute('href')||'').includes('#playback-policy');
      const selected=isPolicy?location.hash==='#playback-policy':location.hash!=='#playback-policy';
      link.classList.toggle('active',selected);
      if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange',syncPlaybackAnchor);
  syncPlaybackAnchor();

  if(path==='/admin/settings/integrations')document.body.classList.add('page-connections-directory');
  if(path==='/admin/settings/commerce')document.body.classList.add('page-settings-commerce');
})();
