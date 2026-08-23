'use strict';

(() => {
  const CONTAINER_SELECTOR = [
    '.section',
    '.card',
    '.panel',
    '.operatorDetails',
    '.capabilitySection',
    '.analyticsCard',
    '.serverCard',
    '.integrationCard'
  ].join(',');

  // A table is a configuration surface only when it contains a setting the
  // operator can define. Generic row-selection checkboxes and action buttons
  // remain data-table affordances rather than changing the table's meaning.
  const MUTABLE_TABLE_CONTROL = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([readonly]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([readonly]):not([disabled])',
    '.inlineToggle input[type="checkbox"]:not([disabled])',
    '[role="switch"]',
    '[data-setting-control]'
  ].join(',');

  const MUTABLE_SETTING_CONTROL = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([readonly]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([readonly]):not([disabled])',
    '.inlineToggle input[type="checkbox"]:not([disabled])',
    '[role="switch"]',
    '[data-setting-control]'
  ].join(',');

  const OVERVIEW_SELECTOR = [
    '.sectionGraphicHero',
    '.sectionInsightCard',
    '.metric',
    '.stat-card',
    '.summaryCard',
    '.operatorHeroFact',
    '.analyticsKpi',
    '.capabilitySummary',
    '.serverControlStat',
    '.controlCentreSummary > div',
    '.dashboardFocusCard',
    '.sectionStat',
    '.sectionMeter'
  ].join(',');

  const HEADER_SELECTOR = [
    ':scope > .sectionHead',
    ':scope > .card-header',
    ':scope > .capabilitySectionHead',
    ':scope > .analyticsCardHeader',
    ':scope > .serverTop',
    ':scope > header'
  ].join(',');

  function explicitKind(container) {
    const explicit = String(container.dataset.adminSurface || '').trim().toLowerCase();
    return ['control', 'data', 'overview'].includes(explicit) ? explicit : '';
  }

  function kindFor(container) {
    const explicit = explicitKind(container);
    if (explicit) return explicit;
    const tables = Array.from(container.querySelectorAll('table'));
    return tables.some(table => table.querySelector(MUTABLE_TABLE_CONTROL)) ? 'control' : 'data';
  }

  function labelSurface(container, kind) {
    container.classList.add('adminSurface', `adminSurface--${kind}`);
    container.dataset.adminSurfaceResolved = kind;

    let header = null;
    try { header = container.querySelector(HEADER_SELECTOR); } catch (_) {}
    if (!header || header.querySelector('[data-admin-surface-kind]')) return;

    const marker = document.createElement('span');
    marker.className = 'adminSurfaceKind';
    marker.dataset.adminSurfaceKind = kind;
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = kind === 'control' ? 'Configuration' : 'Read only';
    header.appendChild(marker);
  }

  function classifyTables(root = document) {
    root.querySelectorAll('table').forEach(table => {
      const container = table.closest(CONTAINER_SELECTOR) || table.closest('.tableWrap,.table-container') || table.parentElement;
      if (!container || container.dataset.adminSurfaceResolved) return;
      labelSurface(container, kindFor(container));
    });
  }

  function classifyStandaloneControls(root = document) {
    root.querySelectorAll(CONTAINER_SELECTOR).forEach(container => {
      if (container.dataset.adminSurfaceResolved || container.querySelector('table')) return;
      const explicit = explicitKind(container);
      if (explicit) return labelSurface(container, explicit);
      if (container.querySelector(MUTABLE_SETTING_CONTROL)) labelSurface(container, 'control');
    });
  }

  function classifyOverview(root = document) {
    root.querySelectorAll(OVERVIEW_SELECTOR).forEach(element => {
      if (element.closest('.adminSurface--control')) return;
      element.classList.add('adminOverviewSurface');
    });
  }

  function classify(root = document) {
    classifyTables(root);
    classifyStandaloneControls(root);
    classifyOverview(root);
  }

  function scheduleClassification() {
    if (scheduleClassification.pending) return;
    scheduleClassification.pending = true;
    requestAnimationFrame(() => {
      scheduleClassification.pending = false;
      classify(document);
    });
  }

  classify(document);

  const target = document.querySelector('.content,.pageContent,.adminMain,.mainPane');
  if (target && typeof MutationObserver === 'function') {
    const observer = new MutationObserver(scheduleClassification);
    observer.observe(target, { childList: true, subtree: true });
  }
})();
