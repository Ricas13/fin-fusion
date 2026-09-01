'use strict';

(function(){
  const form=document.querySelector('[data-plan-access-editor]');if(!form)return;
  const model=form.querySelector('[data-jellyfin-access-model]'),stream=form.querySelectorAll('[data-jellyfin-stream-fields]'),household=form.querySelectorAll('[data-jellyfin-household-fields]');
  function sync(){const isHousehold=model?.value==='household_network';stream.forEach(el=>{el.hidden=false;});household.forEach(el=>{el.hidden=!isHousehold;});}
  model?.addEventListener('change',sync);sync();
})();
