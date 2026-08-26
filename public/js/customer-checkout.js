'use strict';
(function(){
  const field=document.querySelector('[data-shared-promo]');
  if(!field)return;
  const targets=()=>Array.from(document.querySelectorAll('[data-promo-target]'));
  function sync(){const value=String(field.value||'').trim().toUpperCase().slice(0,40);field.value=value;for(const input of targets())input.value=value;}
  field.addEventListener('input',()=>{for(const input of targets())input.value=String(field.value||'').trim().slice(0,40);});
  field.addEventListener('change',sync);
  document.addEventListener('submit',event=>{if(event.target&&event.target.matches('.checkoutForm'))sync();},true);
  const clear=document.querySelector('[data-clear-promo]');
  if(clear)clear.addEventListener('click',()=>{field.value='';sync();field.focus();});
  sync();
})();