'use strict';

(() => {
  document.querySelectorAll('[data-marketing-schedule-form]').forEach(form => {
    form.addEventListener('submit', event => {
      const local=form.querySelector('[data-marketing-local-time]');
      const iso=form.querySelector('[data-marketing-scheduled-iso]');
      if(!local||!iso)return;
      const value=String(local.value||'').trim();
      const parsed=value?new Date(value):null;
      if(!parsed||Number.isNaN(parsed.getTime())){
        event.preventDefault();
        local.setCustomValidity('Choose a valid schedule date and time.');
        local.reportValidity();
        return;
      }
      local.setCustomValidity('');
      iso.value=parsed.toISOString();
    });
    const local=form.querySelector('[data-marketing-local-time]');
    local?.addEventListener('input',()=>local.setCustomValidity(''));
  });
})();
