'use strict';

(() => {
  if (window.__captainfinOrdersUnifiedBound) return;
  window.__captainfinOrdersUnifiedBound = true;

  if (!document.querySelector('link[data-orders-visual-polish]')) {
    const polish = document.createElement('link');
    polish.rel = 'stylesheet';
    polish.href = '/css/admin-orders-visual-polish.css';
    polish.dataset.ordersVisualPolish = 'true';
    document.head.appendChild(polish);
  }

  const calendarSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3v3M17 3v3M4.5 9h15M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5Z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const panelSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4.5h10A2.5 2.5 0 0 1 19.5 7v10A2.5 2.5 0 0 1 17 19.5H7A2.5 2.5 0 0 1 4.5 17V7A2.5 2.5 0 0 1 7 4.5Z" stroke-width="1.8"/><path d="M8 9.25h8M8 12h5.5M8 14.75h7" stroke-width="1.8" stroke-linecap="round"/></svg>';
  document.querySelectorAll('.ordersCalendarIcon').forEach(icon => { icon.innerHTML = calendarSvg; });
  document.querySelectorAll('.ordersPanelIcon').forEach(icon => { icon.innerHTML = panelSvg; });

  const accessibleLabels = {
    orderStatus: 'Filter purchases by status',
    orderProvider: 'Filter purchases by provider',
    orderPlan: 'Filter purchases by plan'
  };
  for (const [name, label] of Object.entries(accessibleLabels)) {
    const control = document.querySelector(`[name="${name}"]`);
    if (control && !control.getAttribute('aria-label')) control.setAttribute('aria-label', label);
  }

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

  document.addEventListener('click', event => {
    document.querySelectorAll('.ordersDatePicker[open],.ordersRowMenu[open]').forEach(details => {
      if (!details.contains(event.target)) details.removeAttribute('open');
    });
  });
})();
