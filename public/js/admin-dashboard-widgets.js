'use strict';

(function () {
  const root = document.querySelector('[data-dashboard-key]');
  if (!root) return;
  const dashboardKey = root.getAttribute('data-dashboard-key');
  const toggleButton = document.querySelector('[data-dashboard-customize-toggle]');
  const picker = document.querySelector('[data-widget-picker]');
  const resetButton = document.querySelector('[data-dashboard-reset]');
  const layoutError = document.querySelector('[data-dashboard-layout-error]');
  let dirty = false;

  function csrfToken() {
    return root.getAttribute('data-csrf-token') || '';
  }

  function showLayoutError(message) {
    if (!layoutError) return;
    layoutError.textContent = message;
    layoutError.classList.remove('widgetHidden');
  }

  function clearLayoutError() {
    if (!layoutError) return;
    layoutError.textContent = '';
    layoutError.classList.add('widgetHidden');
  }

  // Every registered widget has a DOM card (hidden ones included -- see
  // admin-dashboard-page.js), so this always reflects the full layout, not
  // just what happens to be visible right now. That's what makes a hidden
  // widget survive an unrelated reorder/resize save: it's still in the DOM,
  // still in this list, still marked invisible.
  function currentWidgets() {
    return [...root.querySelectorAll('[data-widget-key]')].map((card, index) => ({
      widgetKey: card.dataset.widgetKey,
      position: index,
      span: Number(card.dataset.widgetSpan) || 6,
      visible: !card.classList.contains('widgetHidden')
    }));
  }

  async function save() {
    if (!dirty) return;
    try {
      const res = await fetch(`/admin/api/dashboard/${encodeURIComponent(dashboardKey)}/layout`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
        body: JSON.stringify({ widgets: currentWidgets() })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
      dirty = false;
      clearLayoutError();
    } catch (_) {
      // Non-destructive: the current view is unaffected, but the change
      // wasn't persisted, so keep `dirty` set and tell the admin plainly
      // rather than silently discarding their edit.
      showLayoutError('Your dashboard layout changes could not be saved. Nothing on screen was lost, but this change may not survive a reload -- try again.');
    }
  }

  toggleButton?.addEventListener('click', () => {
    document.body.classList.toggle('customizeMode');
    picker?.classList.toggle('widgetHidden');
    if (!document.body.classList.contains('customizeMode')) save();
  });

  resetButton?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/admin/api/dashboard/${encodeURIComponent(dashboardKey)}/layout/reset`, {
        method: 'POST', headers: { 'x-csrf-token': csrfToken() }
      });
      if (res.ok) location.reload();
    } catch (_) { /* ignore */ }
  });

  picker?.addEventListener('click', event => {
    const item = event.target.closest('[data-widget-picker-item]');
    if (!item) return;
    const key = item.dataset.widgetPickerItem;
    const card = root.querySelector(`[data-widget-key="${CSS.escape(key)}"]`);
    if (!card) return;
    card.classList.toggle('widgetHidden');
    const nowVisible = !card.classList.contains('widgetHidden');
    item.classList.toggle('active', nowVisible);
    if (nowVisible) {
      const lazyBody = card.querySelector('[data-lazy-src]');
      if (lazyBody) loadLazy(lazyBody);
    }
    dirty = true;
  });

  root.addEventListener('click', event => {
    const hide = event.target.closest('[data-widget-hide]');
    if (hide) {
      const card = hide.closest('[data-widget-key]');
      if (card) {
        card.classList.add('widgetHidden');
        const pickerItem = picker?.querySelector(`[data-widget-picker-item="${CSS.escape(card.dataset.widgetKey)}"]`);
        pickerItem?.classList.remove('active');
        dirty = true;
      }
      return;
    }
    const spanToggle = event.target.closest('[data-widget-span-toggle]');
    if (spanToggle) {
      const card = spanToggle.closest('[data-widget-key]');
      if (!card) return;
      const spans = [3, 4, 6, 8, 9, 12];
      const current = Number(card.dataset.widgetSpan) || 6;
      const next = spans[(spans.indexOf(current) + 1) % spans.length];
      card.className = card.className.replace(/\bspan-\d+\b/, `span-${next}`);
      card.dataset.widgetSpan = String(next);
      dirty = true;
      return;
    }
    const info = event.target.closest('.widgetInfo');
    if (info) {
      if (typeof info.togglePopover === 'function') info.togglePopover();
    }
  });

  // Reorder: same dragstart/dragover/dragend/dragleave delegation pattern as
  // public/js/admin-plan-order.js, generalized to work on any [data-widget-key].
  document.addEventListener('dragstart', event => {
    const card = event.target.closest('[data-widget-key]');
    if (!card || !document.body.classList.contains('customizeMode')) return;
    card.classList.add('widgetDragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.widgetKey || '');
  });
  document.addEventListener('dragend', event => {
    const card = event.target.closest('[data-widget-key]');
    card?.classList.remove('widgetDragging');
    document.querySelectorAll('.widgetDragTarget').forEach(el => el.classList.remove('widgetDragTarget'));
    dirty = true;
  });
  document.addEventListener('dragover', event => {
    const target = event.target.closest('[data-widget-key]');
    const dragging = document.querySelector('[data-widget-key].widgetDragging');
    if (!target || !dragging || target === dragging || target.parentElement !== dragging.parentElement) return;
    event.preventDefault();
    target.classList.add('widgetDragTarget');
    const rect = target.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    target.parentElement.insertBefore(dragging, before ? target : target.nextSibling);
  });
  document.addEventListener('dragleave', event => event.target.closest('[data-widget-key]')?.classList.remove('widgetDragTarget'));

  [...root.querySelectorAll('[data-widget-key]')].forEach(card => card.setAttribute('draggable', 'true'));

  // Lazy widgets: fetch their fragment shortly after first paint so the initial
  // page load isn't blocked on lower-priority queries. Widgets that are
  // currently hidden are skipped here -- there's no point fetching data the
  // admin can't see -- and are instead loaded on demand from the picker
  // handler above, the moment they're un-hidden.
  function loadLazy(el) {
    if (el.dataset.lazyLoaded) return;
    el.dataset.lazyLoaded = '1';
    fetch(el.getAttribute('data-lazy-src'))
      .then(res => res.json().then(payload => ({ ok: res.ok, payload })))
      .then(({ ok, payload }) => {
        if (ok && payload?.ok) el.innerHTML = payload.html;
        else el.innerHTML = '<div class="analyticsEmpty widgetError">This widget could not be loaded.</div>';
      })
      .catch(() => { el.innerHTML = '<div class="analyticsEmpty widgetError">This widget could not be loaded.</div>'; });
  }
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 200));
  [...root.querySelectorAll('[data-lazy-src]')].forEach(el => {
    const card = el.closest('[data-widget-key]');
    if (card && card.classList.contains('widgetHidden')) return;
    idle(() => loadLazy(el));
  });
})();
