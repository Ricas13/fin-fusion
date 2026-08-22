'use strict';

(function(){
  const form=document.querySelector('[data-plan-create-v2]');if(!form)return;
  const kinds=[...form.querySelectorAll('[data-plan-kind]')];
  const service=form.querySelector('[data-plan-service]');
  const frequency=form.querySelector('[data-plan-frequency]');
  const duration=form.querySelector('[data-plan-duration]');
  const durationGroup=form.querySelector('[data-plan-duration-group]');
  const accessModel=form.querySelector('[data-jellyfin-access-model]');
  const replacement=form.querySelector('[data-stremio-replacement]');
  const commercial=form.querySelector('[data-commercial-card]');
  const paidJellyfin=form.querySelector('[data-paid-jellyfin-only]');
  const jellyfinBlocks=form.querySelectorAll('[data-jellyfin-access],[data-jellyfin-policy],[data-jellyfin-libraries]');
  const stremioBlocks=form.querySelectorAll('[data-stremio-access]');
  const streamFields=form.querySelectorAll('[data-jellyfin-stream-fields]');
  const householdFields=form.querySelectorAll('[data-jellyfin-household-fields]');
  const lifecycle=form.querySelector('[data-free-lifecycle]');
  const replacementCooldown=form.querySelector('[data-stremio-replacement-cooldown]');
  const kindLabel=form.querySelector('[data-plan-kind-label]');
  const saveSummary=form.querySelector('[data-plan-save-summary]');

  function selectedKind(){return kinds.find(input=>input.checked)?.value||'paid_jellyfin';}
  function setVisible(el,visible){
    if(!el)return;
    el.hidden=!visible;
    el.querySelectorAll('input,select,textarea').forEach(control=>{control.disabled=!visible;});
  }
  function toggleAll(nodes,visible){nodes.forEach(el=>setVisible(el,visible));}
  function syncDuration(){
    if(!frequency||!duration)return;
    const option=frequency.selectedOptions?.[0],days=option?.dataset?.days;
    if(days){duration.value=days;duration.readOnly=true;if(durationGroup)durationGroup.hidden=false;}
    else{duration.readOnly=false;if(durationGroup)durationGroup.hidden=false;}
  }
  function sync(){
    const kind=selectedKind();
    const free=kind==='free_jellyfin',paid=kind==='paid_jellyfin',stremio=kind==='stremio',jellyfin=!stremio;
    const household=jellyfin&&accessModel?.value==='household_network';
    if(service)service.value=stremio?'stremio':'jellyfin';
    setVisible(commercial,!free);
    setVisible(paidJellyfin,paid);
    toggleAll(jellyfinBlocks,jellyfin);
    toggleAll(stremioBlocks,stremio);
    toggleAll(streamFields,jellyfin&&!household);
    toggleAll(householdFields,household);
    setVisible(lifecycle,free);
    setVisible(replacementCooldown,stremio&&replacement?.value==='customer_cooldown');
    const label=free?'FREE JELLYFIN':paid?'PAID JELLYFIN':'STREMIO';
    if(kindLabel)kindLabel.textContent=label;
    if(saveSummary)saveSummary.textContent=free?'Free Jellyfin plan':paid?'Paid Jellyfin plan':'Stremio plan';
    kinds.forEach(input=>input.closest('.planKindChoice')?.classList.toggle('selected',input.checked));
    if(!free)syncDuration();
  }

  kinds.forEach(el=>el.addEventListener('change',sync));
  [frequency,accessModel,replacement].filter(Boolean).forEach(el=>{el.addEventListener('change',sync);el.addEventListener('input',sync);});
  sync();
})();
