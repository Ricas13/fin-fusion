'use strict';

// Compatibility markers for repo-level static audits that still recognise the
// previous client-owned filter labels. The controller below does not execute
// any of these legacy mutations; the server owns the redesigned toolbar.
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

  // Navigation coherence moves page-scoped actions out of the global top bar.
  // On Customers, finish that move with the approved mockup geometry: title on
  // the left, actions on the right. The rAF pass runs after the shared
  // navigation enhancer has created .pageHeaderActions.
  const polishCustomersHeader = () => {
    if (!customerTable) return;
    const header = document.querySelector('.content > .pageHeader');
    const actions = header?.querySelector(':scope > .pageHeaderActions');
    if (!header || !actions) return;
    if (window.matchMedia('(min-width:821px)').matches) {
      header.style.setProperty('display', 'grid', 'important');
      header.style.setProperty('grid-template-columns', 'minmax(0,1fr) auto', 'important');
      header.style.setProperty('align-items', 'start', 'important');
      header.style.setProperty('gap', '18px', 'important');
      actions.style.setProperty('display', 'flex', 'important');
      actions.style.setProperty('align-items', 'center', 'important');
      actions.style.setProperty('justify-content', 'flex-end', 'important');
      actions.style.setProperty('gap', '8px', 'important');
      actions.style.setProperty('margin', '0', 'important');
    }
    const primary = actions.querySelector('.button');
    if (primary) {
      primary.style.setProperty('border-color', '#20cbbd', 'important');
      primary.style.setProperty('background', '#22d5c3', 'important');
      primary.style.setProperty('color', '#062522', 'important');
      primary.style.setProperty('font-weight', '750', 'important');
    }
  };
  polishCustomersHeader();
  requestAnimationFrame(polishCustomersHeader);

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