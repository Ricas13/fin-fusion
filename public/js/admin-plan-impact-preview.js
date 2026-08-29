'use strict';

(() => {
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function label(value) {
    return value == null ? '—' : esc(value);
  }
  function serviceLabel(value) {
    return value === 'bundle' ? 'Jellyfin + Stremio' : value === 'stremio' ? 'Stremio' : 'Jellyfin';
  }
  function libraries(mode, count) {
    if (mode == null) return '—';
    return esc(mode) + (count ? ' · ' + Number(count) + ' named' : '');
  }
  function row(labelText, before, after) {
    return `<div class="kvRow"><div class="kvLabel">${labelText}</div><div class="kvValue">${before} → ${after}</div></div>`;
  }

  document.querySelectorAll('[data-plan-impact-select]').forEach(select => {
    const panel = document.querySelector('[data-plan-impact-panel]');
    if (!panel) return;
    let current = {};
    try { current = JSON.parse(panel.getAttribute('data-current-impact') || '{}'); } catch (_) { current = {}; }

    function render() {
      const option = select.options[select.selectedIndex];
      const raw = option ? option.getAttribute('data-plan-impact') : null;
      if (!raw) {
        panel.innerHTML = '<strong>Choose a plan above to preview the entitlement change.</strong>';
        return;
      }
      let next;
      try { next = JSON.parse(raw); } catch (_) { return; }
      panel.innerHTML = '<strong>Plan entitlement impact</strong><div class="subText">Current entitlement snapshot → target plan defaults. Customer-specific policy, library and household overrides are preserved and continue to apply after the manual edit.</div><div class="kvList">'
        + row('Service', serviceLabel(current.serviceType), serviceLabel(next.serviceType))
        + row('Streams', label(current.streams), label(next.streams))
        + row('Server class', label(current.serverClass), label(next.serverClass))
        + row('Libraries', libraries(current.libraryMode, current.libraryCount), libraries(next.libraryMode, next.libraryCount))
        + '</div>';
    }

    select.addEventListener('change', render);
    render();
  });
})();
