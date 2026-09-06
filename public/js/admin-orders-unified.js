'use strict';

(() => {
  if (window.__captainfinOrdersUnifiedBound) return;
  window.__captainfinOrdersUnifiedBound = true;

  const chartStyleRevision = '20260906-orders-charts';
  const chartStyles = [
    ['ordersChartFoundation', `/css/admin-dashboard-analytics.css?v=${chartStyleRevision}`],
    ['ordersVisualPolish', `/css/admin-orders-visual-polish.css?v=${chartStyleRevision}`]
  ];
  for (const [datasetKey, href] of chartStyles) {
    const selector = `link[data-${datasetKey.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]`;
    if (document.querySelector(selector)) continue;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset[datasetKey] = 'true';
    document.head.appendChild(link);
  }

  const calendarSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3v3M17 3v3M4.5 9h15M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5Z" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const panelSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4.5h10A2.5 2.5 0 0 1 19.5 7v10A2.5 2.5 0 0 1 17 19.5H7A2.5 2.5 0 0 1 4.5 17V7A2.5 2.5 0 0 1 7 4.5Z" stroke-width="1.8"/><path d="M8 9.25h8M8 12h5.5M8 14.75h7" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const historySvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4.5h8M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1Z" stroke-width="1.8" stroke-linecap="round"/><path d="M7 5.5H6.5A1.5 1.5 0 0 0 5 7v12a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V7a1.5 1.5 0 0 0-1.5-1.5H17" stroke-width="1.8"/><path d="m8.5 13 2.1 2.1 4.9-5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const searchSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" stroke-width="1.8"/><path d="m15 15 4 4" stroke-width="1.8" stroke-linecap="round"/></svg>';

  document.querySelectorAll('.ordersCalendarIcon').forEach(icon => { icon.innerHTML = calendarSvg; });
  document.querySelectorAll('.ordersPanelIcon').forEach(icon => { icon.innerHTML = panelSvg; });
  document.querySelectorAll('.ordersRenewalStrip .ordersPanelIcon,.ordersDisclosures > .ordersDisclosure:first-child .ordersPanelIcon').forEach(icon => {
    icon.classList.remove('ordersPanelIcon');
    icon.classList.add('ordersCalendarIcon');
    icon.innerHTML = calendarSvg;
  });
  document.querySelectorAll('.ordersDisclosures > .ordersDisclosure:last-child .ordersPanelIcon').forEach(icon => { icon.innerHTML = historySvg; });
  document.querySelectorAll('.ordersDatePicker > summary > span:first-child').forEach(icon => {
    icon.classList.add('ordersCalendarIcon');
    icon.innerHTML = calendarSvg;
  });
  document.querySelectorAll('.ordersSearch > span:first-child').forEach(icon => {
    icon.classList.add('ordersSearchIcon');
    icon.innerHTML = searchSvg;
  });

  const accessibleLabels = {
    orderStatus: 'Filter purchases by status',
    orderProvider: 'Filter purchases by provider',
    orderPlan: 'Filter purchases by plan'
  };
  for (const [name, label] of Object.entries(accessibleLabels)) {
    const control = document.querySelector(`[name="${name}"]`);
    if (control && !control.getAttribute('aria-label')) control.setAttribute('aria-label', label);
  }

  function todayIso() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function purchaseFilterParams() {
    const params = new URLSearchParams();
    const filterForm = document.querySelector('.ordersPurchaseFilters');
    if (!filterForm) return params;
    for (const name of ['orderQ', 'orderStatus', 'orderProvider', 'orderPlan', 'orderFrom', 'orderTo']) {
      const control = filterForm.elements.namedItem(name);
      const value = String(control?.value || '').trim();
      if (value) params.set(name, value);
    }
    return params;
  }

  function analyticsHref(key, from = '', to = '') {
    const params = purchaseFilterParams();
    params.set('range', key);
    params.delete('from');
    params.delete('to');
    params.delete('page');
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return `${location.pathname}?${params.toString()}`;
  }

  function enhanceRangeControl() {
    const legacyForm = document.querySelector('[data-orders-range-form]');
    if (!legacyForm) return;
    const rangeSelect = legacyForm.querySelector('[data-orders-range]');
    const fromInput = legacyForm.querySelector('input[name="from"]');
    const toInput = legacyForm.querySelector('input[name="to"]');
    const rangeLabel = legacyForm.querySelector('.ordersRangeSelect small')?.textContent?.trim() || 'Selected period';
    const current = String(rangeSelect?.value || '30d');
    const from = String(fromInput?.value || '');
    const to = String(toInput?.value || '');
    const today = todayIso();
    const todayActive = current === 'custom' && from === today && to === today;
    const presets = [
      ['today', 'Today'],
      ['7d', '7 days'],
      ['30d', '30 days'],
      ['90d', '90 days'],
      ['180d', '6 months'],
      ['365d', '12 months'],
      ['ytd', 'YTD'],
      ['all', 'All time']
    ];

    const section = document.createElement('section');
    section.className = 'dashboardRangeBar ordersDashboardRangeBar';
    section.dataset.ordersAnalyticsRange = 'true';

    const meta = document.createElement('div');
    meta.className = 'rangeMeta';
    const strong = document.createElement('strong');
    strong.textContent = rangeLabel;
    const description = document.createElement('span');
    description.textContent = 'Every historical KPI and chart below uses this same period. Payment alerts, upcoming renewals and Recent Purchases remain independent.';
    meta.append(strong, description);

    const controls = document.createElement('div');
    controls.className = 'rangeControls';
    const presetWrap = document.createElement('div');
    presetWrap.className = 'rangePresets';
    for (const [key, label] of presets) {
      const link = document.createElement('a');
      const isToday = key === 'today';
      const isActive = isToday ? todayActive : !todayActive && current === key;
      link.className = `rangePreset ${isActive ? 'active' : ''}`;
      link.textContent = label;
      link.href = isToday ? analyticsHref('custom', today, today) : analyticsHref(key);
      presetWrap.appendChild(link);
    }

    const customForm = document.createElement('form');
    customForm.className = 'rangeCustom';
    customForm.method = 'get';
    customForm.action = location.pathname;
    customForm.innerHTML = `<input type="hidden" name="range" value="custom"><label>From<input type="date" name="from" value="${from}" required></label><label>To<input type="date" name="to" value="${to}" required></label><button class="button secondary" type="submit">Apply</button>`;
    customForm.addEventListener('submit', () => {
      for (const [name, value] of purchaseFilterParams()) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = name;
        hidden.value = value;
        customForm.appendChild(hidden);
      }
    });

    controls.append(presetWrap, customForm);
    section.append(meta, controls);
    const hero = legacyForm.closest('.ordersHeroLine');
    if (hero) hero.insertAdjacentElement('afterend', section);
    else legacyForm.insertAdjacentElement('afterend', section);
    legacyForm.remove();
  }

  enhanceRangeControl();

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