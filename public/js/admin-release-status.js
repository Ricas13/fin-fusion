'use strict';

(() => {
  const nodes = [...document.querySelectorAll('[data-release-status]')];
  if (!nodes.length) return;

  function apply(status) {
    const version = `v${status?.version || nodes[0].dataset.releaseVersion || 'unknown'}`;
    for (const node of nodes) {
      node.classList.remove('current', 'warn', 'custom');
      let text = version;
      let label = `CAPTAiNFiN ${version}`;
      if (status?.state === 'update_available') {
        node.classList.add('warn');
        text = `${version} · Update`;
        label = `${version}; update available`;
      } else if (status?.state === 'current') {
        node.classList.add('current');
        label = `${version}; up to date`;
      } else if (status?.state === 'custom_build') {
        node.classList.add('custom');
        text = `${version} · Custom`;
        label = `${version}; custom build`;
      }
      node.textContent = text;
      node.setAttribute('aria-label', label);
      if (status?.label) node.title = status.label;
    }
  }

  fetch('/admin/system/status.json', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('status unavailable')))
    .then(apply)
    .catch(() => {});
})();
