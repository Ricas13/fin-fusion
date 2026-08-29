'use strict';

(() => {
  const plan = document.getElementById('manualGrantPlan');
  const start = document.getElementById('manualGrantStart');
  const end = document.getElementById('manualGrantEnd');
  const amount = document.getElementById('manualGrantAmount');
  const currency = document.getElementById('manualGrantCurrency');
  if (!plan || !start || !end) return;

  function plusDays(dateText, days) {
    const date = new Date(`${dateText}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + Number(days || 30));
    return date.toISOString().slice(0, 10);
  }

  function sync(resetCommercial) {
    const option = plan.options[plan.selectedIndex];
    if (!option) return;
    end.value = plusDays(start.value, option.dataset.days);
    if (resetCommercial) {
      if (amount) amount.value = option.dataset.amount || '0.00';
      if (currency) currency.value = option.dataset.currency || 'GBP';
    }
  }

  plan.addEventListener('change', () => sync(true));
  start.addEventListener('change', () => sync(false));
})();
