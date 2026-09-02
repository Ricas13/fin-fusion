'use strict';

(()=>{
  for(const form of document.querySelectorAll('[data-library-form]')){
    const boxes=()=>[...form.querySelectorAll('input[type="checkbox"][name="library"]')];
    const setAll=checked=>{for(const box of boxes())box.checked=checked;};
    form.querySelector('[data-library-all]')?.addEventListener('click',()=>setAll(true));
    form.querySelector('[data-library-none]')?.addEventListener('click',()=>setAll(false));
  }
})();
