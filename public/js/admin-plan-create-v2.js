'use strict';

(function(){
  const form=document.querySelector('[data-plan-create-v2]');if(!form)return;
  const service=form.querySelector('[data-plan-service]'),price=form.querySelector('[data-plan-price]'),frequency=form.querySelector('[data-plan-frequency]'),duration=form.querySelector('[data-plan-duration]'),accessModel=form.querySelector('[data-jellyfin-access-model]');
  const jellyfinBlocks=form.querySelectorAll('[data-jellyfin-policy],[data-jellyfin-only]'),stremioBlocks=form.querySelectorAll('[data-stremio-household]'),streamFields=form.querySelectorAll('[data-jellyfin-stream-fields]'),householdFields=form.querySelectorAll('[data-jellyfin-household-fields]'),lifecycle=form.querySelector('[data-free-lifecycle]');
  function sync(){
    const type=service?.value||'jellyfin',jellyfin=type==='jellyfin',stremio=type==='stremio',household=jellyfin&&accessModel?.value==='household_network',free=Number(price?.value||0)===0,trial=frequency?.value==='trial';
    jellyfinBlocks.forEach(el=>{el.hidden=!jellyfin;});stremioBlocks.forEach(el=>{el.hidden=!stremio;});streamFields.forEach(el=>{el.hidden=!jellyfin||household;});householdFields.forEach(el=>{el.hidden=!household;});if(lifecycle)lifecycle.hidden=!(jellyfin&&free&&!trial);
    const option=frequency?.selectedOptions?.[0],days=option?.dataset?.days;if(duration){if(days){duration.value=days;duration.readOnly=true;}else duration.readOnly=false;}
  }
  [service,price,frequency,accessModel].filter(Boolean).forEach(el=>{el.addEventListener('change',sync);el.addEventListener('input',sync);});sync();
})();
