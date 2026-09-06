'use strict';

(()=>{
  for(const form of document.querySelectorAll('[data-library-form]')){
    const boxes=()=>[...form.querySelectorAll('input[type="checkbox"][name="library"]')];
    const setAll=checked=>{for(const box of boxes())box.checked=checked;};
    form.querySelector('[data-library-all]')?.addEventListener('click',()=>setAll(true));
    form.querySelector('[data-library-none]')?.addEventListener('click',()=>setAll(false));
  }

  const stremio=document.querySelector('[data-stremio-access]');
  if(!stremio)return;
  const manifest=stremio.querySelector('[data-stremio-manifest]');
  const install=stremio.querySelector('[data-stremio-install]');
  const create=stremio.querySelector('[data-stremio-create]');
  const revoke=stremio.querySelector('[data-stremio-revoke]');
  const copy=stremio.querySelector('[data-stremio-copy]');
  const status=stremio.querySelector('[data-stremio-status]');
  const help=stremio.querySelector('[data-stremio-help]');

  function setStatus(text,tone='good'){
    if(!status)return;
    status.textContent=text;
    status.classList.remove('good','warn','bad');
    status.classList.add(tone);
  }
  function showLink(data){
    if(!data?.manifestUrl){
      if(manifest)manifest.value='No installation link has been created yet.';
      if(help)help.textContent='Create a private installation link when you are ready to use Stremio.';
      if(create)create.hidden=false;
      if(install)install.hidden=true;
      if(revoke)revoke.hidden=true;
      if(copy)copy.disabled=true;
      setStatus('Link needed','warn');
      return;
    }
    if(manifest)manifest.value=data.manifestUrl;
    if(help)help.textContent='Keep this manifest private. Revoking it invalidates the current installation link.';
    if(install){install.href=data.installUrl||data.manifestUrl;install.hidden=false;}
    if(create)create.hidden=true;
    if(revoke)revoke.hidden=false;
    if(copy)copy.disabled=false;
    setStatus('Ready','good');
  }

  fetch('/account/stremio/installation.json',{credentials:'same-origin',headers:{Accept:'application/json'}})
    .then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Stremio installation link could not be loaded.');return data;})
    .then(showLink)
    .catch(error=>{
      if(manifest)manifest.value='Installation link temporarily unavailable.';
      if(help)help.textContent=error.message||'Try again shortly.';
      if(create)create.hidden=true;
      if(install)install.hidden=true;
      if(revoke)revoke.hidden=true;
      if(copy)copy.disabled=true;
      setStatus('Unavailable','warn');
    });

  copy?.addEventListener('click',async()=>{
    if(!manifest?.value||copy.disabled)return;
    try{
      await navigator.clipboard.writeText(manifest.value);
      const previous=copy.textContent;
      copy.textContent='Copied';
      window.setTimeout(()=>{copy.textContent=previous;},1200);
    }catch(_){
      manifest.focus();
      manifest.select();
    }
  });
})();
