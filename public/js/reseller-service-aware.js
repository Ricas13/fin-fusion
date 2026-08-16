'use strict';

(() => {
  if (typeof document === 'undefined') return;

  function sync(select) {
    const form=select.closest('form');
    if(!form)return;
    const selected=select.selectedOptions?.[0];
    const service=String(selected?.dataset?.serviceType||'jellyfin');
    const needsPortal=service==='stremio'||service==='bundle';
    const checkbox=form.querySelector('[data-reseller-create-portal]');
    const email=form.querySelector('[data-reseller-portal-email]');
    const note=form.querySelector('[data-reseller-portal-note]');
    if(checkbox&&needsPortal)checkbox.checked=true;
    if(email)email.required=needsPortal||email.dataset.portalRequired==='1';
    if(note)note.hidden=!needsPortal;
  }

  for(const select of document.querySelectorAll('[data-reseller-plan]')){
    select.addEventListener('change',()=>sync(select));
    sync(select);
  }
})();
