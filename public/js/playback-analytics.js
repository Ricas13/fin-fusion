(() => {
  function injectRangeStyles() {
    if (document.getElementById('playback-range-styles')) return;
    const style = document.createElement('style');
    style.id = 'playback-range-styles';
    style.textContent = `
      .playbackCustomRange{display:none;align-items:end;gap:10px;flex-wrap:wrap;margin:-4px 0 14px;padding:11px 12px;border:1px solid #344451;border-radius:9px;background:#111a22}
      .playbackCustomRange.isOpen{display:flex}
      .playbackCustomRange label{display:grid;gap:5px;color:#7e8d9e;font-size:9px;font-weight:650}
      .playbackCustomRange input{min-height:34px;padding:6px 9px;border:1px solid #344451;border-radius:7px;background:#0e151c;color:#dce4eb;color-scheme:dark;font:inherit;font-size:10px}
      .playbackCustomRange button{min-height:34px;padding:6px 12px;border:1px solid #617eff;border-radius:7px;background:rgba(97,126,255,.12);color:#eef3ff;font:inherit;font-size:10px;font-weight:700;cursor:pointer}
      .playbackCustomRange small{align-self:center;color:#68788a;font-size:9px}
      @media(max-width:680px){.playbackCustomRange{align-items:stretch}.playbackCustomRange label{flex:1 1 140px}.playbackCustomRange input,.playbackCustomRange button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function isoDate(date) {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 10);
  }

  function initRangeControl(root) {
    const select = root.querySelector('#playback-range');
    const form = select?.closest('form');
    const header = root.querySelector('.playbackAnalyticsHeader');
    if (!select || !form || !header) return;

    select.removeAttribute('onchange');
    const additions = [
      ['6m', 'Last 6 months'],
      ['1y', 'Last 1 year'],
      ['ytd', 'YTD'],
      ['custom', 'Set time range']
    ];
    additions.forEach(([value, label]) => {
      if ([...select.options].some((option) => option.value === value)) return;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });

    injectRangeStyles();
    const params = new URL(window.location.href).searchParams;
    const rawRange = params.get('range') || '30';
    const customMatch = rawRange.match(/^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
    const selected = customMatch ? 'custom' : ['7', '30', '90', '6m', '1y', 'ytd'].includes(rawRange) ? rawRange : '30';
    select.value = selected;

    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 86400000);
    const panel = document.createElement('div');
    panel.className = 'playbackCustomRange';
    panel.setAttribute('data-custom-range', '');
    panel.innerHTML = `
      <label>From<input type="date" data-range-from></label>
      <label>To<input type="date" data-range-to></label>
      <button type="button" data-range-apply>Apply range</button>
      <small>Includes the full selected end date.</small>
    `;
    header.insertAdjacentElement('afterend', panel);

    const from = panel.querySelector('[data-range-from]');
    const to = panel.querySelector('[data-range-to]');
    const apply = panel.querySelector('[data-range-apply]');
    const todayIso = isoDate(today);
    from.max = todayIso;
    to.max = todayIso;
    from.value = customMatch?.[1] || isoDate(defaultFrom);
    to.value = customMatch?.[2] || todayIso;

    const openCustom = (open) => panel.classList.toggle('isOpen', open);
    openCustom(selected === 'custom');

    const navigate = (token) => {
      const url = new URL(window.location.href);
      url.searchParams.set('range', token);
      url.hash = 'playback-analytics';
      window.location.assign(url.toString());
    };

    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        openCustom(true);
        from.focus();
        return;
      }
      openCustom(false);
      navigate(select.value);
    });

    apply.addEventListener('click', () => {
      from.setCustomValidity('');
      to.setCustomValidity('');
      if (!from.value || !to.value) {
        const target = !from.value ? from : to;
        target.setCustomValidity('Choose both a start and end date.');
        target.reportValidity();
        return;
      }
      if (from.value > to.value) {
        to.setCustomValidity('End date must be on or after the start date.');
        to.reportValidity();
        return;
      }
      navigate(`custom:${from.value}:${to.value}`);
    });
  }

  function initTabs(root) {
    const tabs = [...root.querySelectorAll('[data-analytics-tab]')];
    const panels = [...root.querySelectorAll('[data-analytics-panel]')];
    if (!tabs.length || !panels.length) return;

    function activate(name, focus = false) {
      tabs.forEach((tab) => {
        const selected = tab.dataset.analyticsTab === name;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.analyticsPanel !== name;
      });
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab.dataset.analyticsTab));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        activate(tabs[next].dataset.analyticsTab, true);
      });
    });

    root.querySelectorAll('[data-analytics-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.analyticsTarget;
        activate(target);
        root.querySelector('.playbackAnalyticsTabs')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  function initRankCards(root) {
    root.querySelectorAll('[data-rank-card]').forEach((card) => {
      const button = card.querySelector('[data-rank-toggle]');
      const extras = [...card.querySelectorAll('.rankExtra')];
      if (!button || !extras.length) {
        if (button) button.hidden = true;
        return;
      }
      let expanded = false;
      const render = () => {
        extras.forEach((row) => { row.hidden = !expanded; });
        button.textContent = expanded ? 'Show top 5 ↑' : button.dataset.moreLabel || 'View all →';
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      };
      button.addEventListener('click', () => {
        expanded = !expanded;
        render();
      });
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-playback-analytics]').forEach((root) => {
      initRangeControl(root);
      initTabs(root);
      initRankCards(root);
    });
  });
})();
