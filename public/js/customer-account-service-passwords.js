'use strict';

(()=>{
  if(!location.pathname.startsWith('/account/security'))return;
  const portalPasswordForm=document.querySelector('form[action="/account/security/password"]');
  const portalPanel=portalPasswordForm?.closest('.panel');
  if(!portalPanel)return;

  async function load(){
    try{
      const response=await fetch('/account/service-passwords/fragment',{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/html'}});
      if(response.status===204||response.status===401)return;
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const html=await response.text();
      if(!html.trim())return;
      const template=document.createElement('template');
      template.innerHTML=html;
      const content=template.content;
      portalPanel.after(content);
      const target=location.hash?document.querySelector(location.hash):null;
      if(target&&['service-passwords','jellyfin','emby','overseerr'].includes(target.id)){
        window.requestAnimationFrame(()=>target.scrollIntoView({block:'start'}));
      }
    }catch(_){
      // Account security remains fully usable if the optional service-password
      // fragment cannot be loaded; the compatibility routes remain available.
    }
  }

  load();
})();
