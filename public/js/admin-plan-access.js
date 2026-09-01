'use strict';

(function(){
  const form=document.querySelector('[data-plan-access-editor],#access form[action*="/editor-access"]');
  if(!form)return;
  const model=form.querySelector('[data-jellyfin-access-model]'),stream=form.querySelectorAll('[data-jellyfin-stream-fields]'),household=form.querySelectorAll('[data-jellyfin-household-fields]');

  function help(group,text){
    if(!group)return;
    let item=group.querySelector(':scope > .inlineHelp');
    if(!item){item=document.createElement('div');item.className='inlineHelp';group.appendChild(item);}
    item.textContent=text;
  }
  function sync(){
    const isHousehold=model?.value==='household_network';
    stream.forEach(el=>{el.hidden=false;
      const input=el.querySelector('input[name="streams"]');
      if(input)input.min='0';
      help(input?.closest('.formGroup'),'0 = unlimited. Maximum simultaneous playing sessions; independent of IP, registered-device and legacy household limits.');
    });
    household.forEach(el=>{el.hidden=!isHousehold;});
    if(model){
      const group=model.closest('.formGroup');
      const label=group?.querySelector('label');
      if(label)label.textContent='Legacy household lease';
      for(const option of model.options||[]){
        if(option.value==='concurrent_streams')option.textContent='Off';
        if(option.value==='household_network')option.textContent='Also enforce household network lease';
      }
      help(group,'Optional legacy network lease. Concurrent streams remain independently configurable above/below and the active-IP cap remains in Advanced Settings.');
    }
  }
  model?.addEventListener('change',sync);
  sync();
  // admin-settings-groups is loaded dynamically from the same shell and may
  // relabel this card after us. Re-assert the independent-limit wording once
  // the page has finished loading without relying on script fetch order.
  window.addEventListener('load',sync,{once:true});
})();
