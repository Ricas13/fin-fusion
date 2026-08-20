'use strict';

(() => {
  const forms = [...document.querySelectorAll('form[action="/admin/discounts"]')];
  for (const form of forms) {
    const type = form.querySelector('select[name="discountType"]');
    const percent = form.querySelector('input[name="percentOff"]');
    const fixed = form.querySelector('input[name="fixedOff"]');
    const currency = form.querySelector('select[name="currency"]');
    if (!type || !percent || !fixed || !currency) continue;

    const percentGroup = percent.closest('.formGroup');
    const fixedGroup = fixed.closest('.formGroup');
    const currencyGroup = currency.closest('.formGroup');

    const update = () => {
      const isFixed = type.value === 'fixed';
      if (percentGroup) percentGroup.hidden = isFixed;
      if (fixedGroup) fixedGroup.hidden = !isFixed;
      if (currencyGroup) currencyGroup.hidden = !isFixed;
      percent.disabled = isFixed;
      percent.required = !isFixed;
      fixed.disabled = !isFixed;
      fixed.required = isFixed;
      currency.disabled = !isFixed;
    };

    type.addEventListener('change', update);
    update();
  }
})();
