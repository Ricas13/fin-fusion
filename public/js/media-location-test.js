'use strict';

(() => {
  const roots = Array.from(document.querySelectorAll('[data-media-location-test]'));
  if (!roots.length) return;

  async function probe(choice) {
    if (!choice.testUrl) return { ok:false,label:choice.label,reason:'Test unavailable' };
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(choice.testUrl, {
        method:'GET',
        mode:'no-cors',
        cache:'no-store',
        signal:controller.signal,
        credentials:'omit',
        referrerPolicy:'no-referrer'
      });
      return {
        ok:true,
        label:choice.label,
        latencyMs:Math.max(1,Math.round(performance.now()-started))
      };
    } catch (_) {
      return { ok:false,label:choice.label,reason:'Unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  for (const root of roots) {
    const button = root.querySelector('[data-test-media-locations]');
    const status = root.querySelector('[data-media-location-status]');
    const choices = Array.from(root.querySelectorAll('[data-media-location-choice]')).map(node => ({
      label:String(node.dataset.label || 'Location'),
      testUrl:String(node.dataset.testUrl || '')
    }));
    if (!button || !status || !choices.length) continue;

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Testing available locations…';
      try {
        const results = await Promise.all(choices.map(probe));
        status.textContent = results.map(result =>
          result.ok ? `${result.label}: ${result.latencyMs} ms` : `${result.label}: unavailable`
        ).join(' · ');
      } finally {
        button.disabled = false;
      }
    });
  }
})();
