'use strict';

(()=>{
  const rangeSelect=document.querySelector('[data-activity-range-select]');
  if(rangeSelect){
    rangeSelect.addEventListener('change',()=>{
      if(rangeSelect.form?.requestSubmit)rangeSelect.form.requestSubmit();
      else rangeSelect.form?.submit();
    });
  }

  document.querySelectorAll('[data-activity-poster-image]').forEach(image=>{
    image.addEventListener('error',()=>image.remove(),{once:true});
  });
})();
