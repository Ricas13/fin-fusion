'use strict';

(() => {
  const pageKey = document.querySelector('.adminTab.active')?.getAttribute('href') || location.pathname;
  const seenKey = `captainfin.operator.seen.${pageKey}`;
  try { localStorage.setItem(seenKey, String(Date.now())); } catch (_) {}

  // The unread endpoint is deliberately optional. Older deployments and pages
  // continue to work if it is unavailable during a rolling update.
  fetch('/admin/api/operator-state/unread', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.counts) return;
      const hrefByKey = {
        customers: '/admin/users',
        resellers: '/admin/reseller-management',
        attention: '/admin/attention',
        servers: '/admin/servers',
        payments: '/admin/payments'
      };
      for (const [key,countValue] of Object.entries(data.counts)) {
        const count = Number(countValue || 0);
        if (count <= 0) continue;
        const href = hrefByKey[key];
        if (!href) continue;
        const link = [...document.querySelectorAll('.adminTab')].find(a => (a.getAttribute('href') || '').split('?')[0] === href);
        if (!link) continue;
        const serverUpdated = Number(data.updatedAt?.[key] || 0);
        let localSeen = 0;
        try { localSeen = Number(localStorage.getItem(`captainfin.operator.seen.${href}`) || 0); } catch (_) {}
        if (serverUpdated && localSeen >= serverUpdated) continue;
        const badge = document.createElement('span');
        badge.className = 'unreadBadge';
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.setAttribute('aria-label', `${count} unread`);
        link.appendChild(badge);
      }
    })
    .catch(() => {});

  // Provide lightweight discoverability on dense admin controls without
  // replacing explicit labels or keyboard focus.
  document.querySelectorAll('[title]:not([data-help])').forEach(el => {
    const value = (el.getAttribute('title') || '').trim();
    if (value.length > 5 && value.length < 180) el.setAttribute('data-help', value);
  });
})();
