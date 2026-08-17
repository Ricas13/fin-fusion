'use strict';
document.addEventListener('DOMContentLoaded',()=>{
  const all=document.getElementById('checkAllPage');
  const rows=()=>Array.from(document.querySelectorAll('.rowCheck'));
  const button=document.querySelector('#bulkForm button[type="submit"],#bulkForm button:not([type])');
  const sync=()=>{
    const selected=rows().filter(x=>x.checked).length;
    if(button)button.textContent=selected?`Continue with ${selected} selected`:'Continue';
    if(all){all.checked=rows().length>0&&selected===rows().length;all.indeterminate=selected>0&&selected<rows().length;}
  };
  all?.addEventListener('change',()=>{rows().forEach(x=>x.checked=all.checked);sync();});
  rows().forEach(x=>x.addEventListener('change',sync));
  sync();
});
