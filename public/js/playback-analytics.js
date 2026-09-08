(() => {
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
      initTabs(root);
      initRankCards(root);
    });
  });
})();
