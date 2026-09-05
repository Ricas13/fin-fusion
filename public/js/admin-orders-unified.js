'use strict';

(() => {
  if (window.__captainfinOrdersUnifiedBound) return;
  window.__captainfinOrdersUnifiedBound = true;

  const rangeForm = document.querySelector('[data-orders-range-form]');
  const range = rangeForm?.querySelector('[data-orders-range]');
  const custom = rangeForm?.querySelector('[data-orders-custom]');
  if (range && rangeForm) {
    range.addEventListener('change', () => {
      const isCustom = range.value === 'custom';
      if (custom) custom.hidden = !isCustom;
      if (!isCustom) {
        rangeForm.querySelectorAll('input[name="from"],input[name="to"]').forEach(input => { input.disabled = true; });
        rangeForm.submit();
      } else {
        rangeForm.querySelectorAll('input[name="from"],input[name="to"]').forEach(input => { input.disabled = false; });
        custom?.querySelector('input[name="from"]')?.focus();
      }
    });
  }

  document.querySelectorAll('.ordersPurchaseFilters select').forEach(select => {
    select.addEventListener('change', () => {
      const form = select.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    });
  });

  document.querySelectorAll('.ordersDisclosure').forEach(details => {
    details.addEventListener('toggle', () => {
      const chevron = details.querySelector(':scope > summary > span:last-child');
      if (chevron) chevron.textContent = details.open ? '⌃' : '⌄';
    });
  });
})();
