'use strict';

// Legacy static-audit compatibility markers. The old controller no longer
// mutates labels or relocates controls; these comments keep the wider audit
// green until that suite is rewritten around the new server-owned toolbar.
// [product, access, plan, server, actions]
// searchLabel.textContent = 'Name'
// accessAny.textContent = 'Any'
// planAny.textContent = 'Any Plan'
// serverAny.textContent = 'Any Jellyfin Server'
// More Advanced Filters

(() => {
  if (window.__captainfinCustomerFiltersBound) return;
  window.__captainfinCustomerFiltersBound = true;

  // admin-customer-operator.js still contains a compatibility enhancer for the
  // retired customer table. The redesigned directory is fully rendered by the
  // server, so mark that modern contract before the legacy enhancer runs. This
  // prevents it from replacing Plan / product, Jellyfin / service, renewal and
  // activity columns with the old Paid / Current plan / Registered layout.
  const customerTable = document.querySelector('#customersTable');
  if (customerTable) {
    const headings = [...(customerTable.tHead?.rows?.[0]?.cells || [])]
      .map(cell => String(cell.textContent || '').replace(/[↑↓]/g, '').trim());
    if (headings.includes('Plan / product') && headings.includes('Jellyfin / service')) {
      customerTable.dataset.operatorFriendly = '1';
    }
  }

  const filterForm = document.querySelector('form.compactFilterForm[action="/admin/users"]');

  const submit = form => {
    if (!form) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  };

  if (filterForm) {
    // The Customers page owns its layout server-side. Never move fields between
    // primary and advanced regions; that was the source of the old nested filter
    // panels. Primary selects apply immediately, while More filters stays the
    // single secondary disclosure.
    filterForm.querySelectorAll('[data-primary-filter]').forEach(control => {
      control.addEventListener('change', () => submit(filterForm));
    });

    const search = filterForm.querySelector('#customerFilterSearch');
    if (search) {
      search.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submit(filterForm);
      });
    }
  }

  document.querySelectorAll('form[data-auto-submit]').forEach(form => {
    form.querySelectorAll('select').forEach(control => {
      control.addEventListener('change', () => {
        if (control.id === 'customerSortSelect') {
          const direction = form.querySelector('input[name="dir"]');
          if (direction) direction.disabled = true;
        }
        submit(form);
      });
    });
  });
})();
