'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  const all=document.getElementById('checkAllPage');
  const bar=document.querySelector('[data-bulk-bar]');
  const count=document.querySelector('[data-bulk-count]');
  const allMatching=document.querySelector('[data-select-all-matching]');
  const clear=document.querySelector('[data-clear-selection]');
  const rows=()=>Array.from(document.querySelectorAll('.rowCheck'));
  const button=document.querySelector('#bulkForm button[type="submit"],#bulkForm button:not([type])');
  const sync=()=>{
    const selected=rows().filter(x=>x.checked).length;
    const matching=Boolean(allMatching?.checked);
    if(count)count.textContent=matching?'All matching':String(selected);
    if(button)button.textContent=matching?'Continue with all matching':selected?`Continue with ${selected} selected`:'Continue';
    if(all){all.checked=rows().length>0&&selected===rows().length;all.indeterminate=selected>0&&selected<rows().length;}
    if(bar)bar.hidden=selected===0&&!matching;
  };
  all?.addEventListener('change',()=>{rows().forEach(x=>x.checked=all.checked);sync();});
  rows().forEach(x=>x.addEventListener('change',sync));
  allMatching?.addEventListener('change',sync);
  clear?.addEventListener('click',()=>{rows().forEach(x=>{x.checked=false;});if(allMatching)allMatching.checked=false;sync();});
  sync();
});
