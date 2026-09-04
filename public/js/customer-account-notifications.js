'use strict';

(()=>{
  const path=location.pathname.replace(/\/+$/,'')||'/';

  // Notifications now live inside Account. Keep the legacy URL as a safe
  // landing point for existing form redirects, OAuth callbacks and bookmarks.
  if(path==='/account/communications'){
    const incoming=new URLSearchParams(location.search);
    const target=new URL('/account/security',location.origin);
    for(const key of ['message','error']){
      const value=incoming.get(key);
      if(value)target.searchParams.set(key,value);
    }
    target.hash='notifications';
    location.replace(`${target.pathname}${target.search}${target.hash}`);
    return;
  }

  if(path!=='/account/security')return;
  const host=document.querySelector('.securityMain');
  if(!host||document.getElementById('notifications'))return;

  const stylesheet=document.createElement('link');
  stylesheet.rel='stylesheet';
  stylesheet.href='/css/customer-account-notifications.css';
  document.head.appendChild(stylesheet);

  const section=document.createElement('section');
  section.id='notifications';
  section.className='sectionBlock accountNotifications';
  section.innerHTML='<div class="sectionHead"><div><h2>Notifications</h2><p>Choose where optional updates reach you. Important account and payment email cannot be switched off.</p></div></div><div class="panel accountNotificationsLoading">Loading notification settings…</div>';
  host.appendChild(section);

  fetch('/account/communications?embed=1',{
    headers:{Accept:'text/html'},
    credentials:'same-origin',
    cache:'no-store'
  }).then(response=>{
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return response.text();
  }).then(html=>{
    const doc=new DOMParser().parseFromString(html,'text/html');
    const source=doc.querySelector('main.customerPortalPage');
    if(!source)throw new Error('Notification settings markup was not found.');
    const content=[...source.children].filter(node=>node.matches?.('.panel,.notifyGrid'));
    if(!content.length)throw new Error('Notification settings are unavailable.');
    section.querySelector('.accountNotificationsLoading')?.remove();
    for(const node of content)section.appendChild(document.importNode(node,true));
  }).catch(()=>{
    const loading=section.querySelector('.accountNotificationsLoading');
    if(loading)loading.textContent='Notification settings could not be loaded right now. Refresh the page to try again.';
  });
})();
