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

  const MUTABLE_TABLE_CONTROL = [
    'input:not([type="hidden"]):not([type="submit"]):not([readonly]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([readonly]):not([disabled])',
    '[role="switch"]',
    '[data-setting-control]',
    'button[type="submit"]'
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

  function kindFor(container, table) {
    const explicit = String(container.dataset.adminSurface || '').trim().toLowerCase();
    if (['control', 'data', 'overview'].includes(explicit)) return explicit;
    return table.querySelector(MUTABLE_TABLE_CONTROL) ? 'control' : 'data';
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
      labelSurface(container, kindFor(container, table));
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
