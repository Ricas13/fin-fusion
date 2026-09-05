'use strict';

(() => {
  const form = document.querySelector('form.compactFilterForm[action="/admin/users"]');
  if (!form) return;

  // The Customers page owns its layout server-side. Never move primary fields
  // into the collapsed advanced <details> panel. The old enhancer grabbed the
  // first .formGrid (which is inside that panel) and caused the visible filters
  // to disappear behind "More filters".
  const primary = form.querySelector('.customerPrimaryFilters');
  const groupFor = name => form.querySelector(`[name="${name}"]`)?.closest('.formGroup');
  if (primary) {
    const product = groupFor('service');
    const access = groupFor('access');
    const plan = groupFor('plan');
    const server = groupFor('server');
    const actions = primary.querySelector('.customerFilterActions');
    [product, access, plan, server, actions].forEach(node => {
      if (node) primary.appendChild(node);
    });
  }

  const searchLabel = form.querySelector('label[for="customerFilterSearch"]');
  if (searchLabel) searchLabel.textContent = 'Name';

  const accessAny = form.querySelector('#customerFilterAccess option[value=""]');
  if (accessAny) accessAny.textContent = 'Any';
  const planAny = form.querySelector('#customerFilterPlan option[value=""]');
  if (planAny) planAny.textContent = 'Any Plan';
  const serverAny = form.querySelector('#customerFilterServer option[value=""]');
  if (serverAny) serverAny.textContent = 'Any Jellyfin Server';

  const advanced = form.querySelector('details.customerAdvancedFilters > summary');
  if (advanced) {
    const active = advanced.textContent.includes('· active');
    advanced.textContent = `More Advanced Filters${active ? ' · active' : ''}`;
  }

  const submitNow = () => {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  };

  form.querySelectorAll('.customerPrimaryFilters select').forEach(control => {
    control.addEventListener('change', submitNow);
  });
})();
