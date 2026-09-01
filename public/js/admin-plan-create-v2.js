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
  function checkbox(name){return form.querySelector(`input[type="checkbox"][name="${name}"]`);}
  function setChecked(name,value){const control=checkbox(name);if(control)control.checked=Boolean(value);}
  function applyRecommendedJellyfinPolicy(){
    const kind=selectedKind();
    if(kind==='stremio')return;
    const paidRecurring=kind==='paid_jellyfin'&&frequency?.value!=='trial';
    // Product defaults are intentionally conservative. Paid recurring Jellyfin
    // includes downloads; Free and Trial do not. Conversion and Live TV stay
    // opt-in so creating a plan cannot silently grant expensive capabilities.
    setChecked('allowDownloads',paidRecurring);
    setChecked('allowVideoTranscoding',false);
    setChecked('allowAudioTranscoding',false);
    setChecked('allowRemuxing',false);
    setChecked('allowLiveTv',false);
    setChecked('allowLiveTvManagement',false);
    setChecked('allowRemoteAccess',true);
  }
  function syncDuration(){
    if(!frequency||!duration)return;
    const option=frequency.selectedOptions?.[0],days=option?.dataset?.days;
    if(days){duration.value=days;duration.readOnly=true;if(durationGroup)durationGroup.hidden=false;}
    else{duration.readOnly=false;if(durationGroup)durationGroup.hidden=false;}
  }
  function syncAccessCopy(){
    for(const block of streamFields){
      const input=block.querySelector('input[name="streams"]');
      if(input)input.min='0';
      const group=input?.closest('.formGroup');
      let help=group?.querySelector('.inlineHelp');
      if(group&&!help){help=document.createElement('div');help.className='inlineHelp';group.appendChild(help);}
      if(help)help.textContent='0 = unlimited. Concurrent streams are independent of IP, registered-device and legacy household limits.';
    }
    if(accessModel){
      const group=accessModel.closest('.formGroup');
      const label=group?.querySelector('label');
      if(label)label.textContent='Legacy household lease';
      for(const option of accessModel.options||[]){
        if(option.value==='concurrent_streams')option.textContent='Off';
        if(option.value==='household_network')option.textContent='Also enforce household network lease';
      }
      const help=group?.querySelector('.inlineHelp');
      if(help)help.textContent='Optional legacy network lease. It does not replace the concurrent-stream limit.';
    }
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
    toggleAll(streamFields,jellyfin);
    toggleAll(householdFields,household);
    setVisible(lifecycle,free);
    setVisible(replacementCooldown,stremio&&replacement?.value==='customer_cooldown');
    syncAccessCopy();
    const label=free?'FREE JELLYFIN':paid?'PAID JELLYFIN':'STREMIO';
    if(kindLabel)kindLabel.textContent=label;
    if(saveSummary)saveSummary.textContent=free?'Free Jellyfin plan':paid?'Paid Jellyfin plan':'Stremio plan';
    kinds.forEach(input=>input.closest('.planKindChoice')?.classList.toggle('selected',input.checked));
    if(!free)syncDuration();
  }

  kinds.forEach(el=>el.addEventListener('change',()=>{applyRecommendedJellyfinPolicy();sync();}));
  if(frequency)frequency.addEventListener('change',()=>{applyRecommendedJellyfinPolicy();sync();});
  [accessModel,replacement].filter(Boolean).forEach(el=>{el.addEventListener('change',sync);el.addEventListener('input',sync);});
  applyRecommendedJellyfinPolicy();
  sync();
})();
