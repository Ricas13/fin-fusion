'use strict';

(()=>{
  document.querySelectorAll('[data-activity-range-select],[data-activity-scope-select]').forEach(select=>{
    select.addEventListener('change',()=>{
      if(select.form?.requestSubmit)select.form.requestSubmit();
      else select.form?.submit();
    });
  });

  document.querySelectorAll('[data-activity-poster-image]').forEach(image=>{
    image.addEventListener('error',()=>image.remove(),{once:true});
  });
})();
