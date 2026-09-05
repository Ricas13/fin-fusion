'use strict';

(() => {
  const form = document.querySelector('form.compactFilterForm[action="/admin/users"]');
  if (!form) return;

  // The Customers page now owns its filter layout server-side. Do not move
  // fields between the visible primary row and the collapsed advanced panel.
  // The previous enhancer grabbed the first .formGrid (inside <details>) and
  // accidentally moved Search, Product, Plan and Server into that collapsed
  // section.
  const submitNow = () => {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  };

  form.querySelectorAll('.customerPrimaryFilters select').forEach(control => {
    control.addEventListener('change', submitNow);
  });
})();
