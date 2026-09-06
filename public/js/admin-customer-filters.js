'use strict';

(() => {
  if (window.__captainfinCustomerFiltersBound) return;
  window.__captainfinCustomerFiltersBound = true;

  // The redesigned Customers directory is server-rendered. Mark its table as
  // authoritative before the legacy admin-customer-operator compatibility
  // enhancer runs, so changing operator-facing column labels cannot cause the
  // old Paid / Current plan / Registered table to be reconstructed at runtime.
  const customerTable = document.querySelector('#customersTable');
  if (customerTable) customerTable.dataset.operatorFriendly = '1';

  // Keep renewal/expiry dates as a simple traffic-light signal:
  // green while comfortably inside the access period, amber inside the final
  // 48 hours, and red once expired.
  const colourCustomerExpiryDates = () => {
    if (!customerTable) return;

    if (!document.querySelector('#customerExpiryTrafficLightStyles')) {
      const style = document.createElement('style');
      style.id = 'customerExpiryTrafficLightStyles';
      style.textContent = [
        '.customerTable td[data-label="Renewal / expiry"] .customerDateTone.good{color:#5ae0a0!important}',
        '.customerTable td[data-label="Renewal / expiry"] .customerDateTone.warn{color:#e6bd62!important}',
        '.customerTable td[data-label="Renewal / expiry"] .customerDateTone.bad{color:#ff6f78!important}'
      ].join('');
      document.head.append(style);
    }

    const monthIndex = new Map([
      ['jan', 0], ['feb', 1], ['mar', 2], ['apr', 3], ['may', 4], ['jun', 5],
      ['jul', 6], ['aug', 7], ['sep', 8], ['sept', 8], ['oct', 9], ['nov', 10], ['dec', 11]
    ]);
    const parseDisplayDate = value => {
      const match = String(value || '').trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
      if (!match) return NaN;
      const month = monthIndex.get(match[2].toLowerCase());
      if (month === undefined) return NaN;
      return new Date(Number(match[3]), month, Number(match[1]), 23, 59, 59, 999).getTime();
    };

    const now = Date.now();
    const fortyEightHours = 48 * 60 * 60 * 1000;
    const colours = { good: '#5ae0a0', warn: '#e6bd62', bad: '#ff6f78' };
    customerTable.querySelectorAll('td[data-label="Renewal / expiry"]').forEach(cell => {
      const primary = cell.querySelector('strong');
      if (!primary) return;
      const label = primary.textContent.trim();
      if (!label || label === '—' || label === 'Permanent') return;

      const secondary = cell.querySelector('.subText');
      const expiryMs = parseDisplayDate(label);
      const explicitlyExpired = /^Expired\b/i.test(secondary?.textContent || '');
      let tone = 'good';
      if (explicitlyExpired || (Number.isFinite(expiryMs) && expiryMs < now)) tone = 'bad';
      else if (Number.isFinite(expiryMs) && expiryMs - now <= fortyEightHours) tone = 'warn';

      [primary, secondary].filter(Boolean).forEach(node => {
        node.classList.remove('good', 'warn', 'bad');
        node.classList.add('customerDateTone', tone);
        node.style.setProperty('color', colours[tone], 'important');
      });
    });
  };
  colourCustomerExpiryDates();

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
