'use strict';

(() => {
  const plan = document.getElementById('manualGrantPlan');
  const start = document.getElementById('manualGrantStart');
  const end = document.getElementById('manualGrantEnd');
  const amount = document.getElementById('manualGrantAmount');
  const currency = document.getElementById('manualGrantCurrency');
  const serverGroup = document.getElementById('manualGrantServerGroup');
  const server = document.getElementById('manualGrantServer');
  if (!plan || !start || !end) return;

  function plusDays(dateText, days) {
    const date = new Date(`${dateText}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + Number(days || 30));
    return date.toISOString().slice(0, 10);
  }

  function capacityLabel(row) {
    const users = Number(row.assigned_users || 0), max = Number(row.max_users || 0);
    if (!max) return `${users} user${users === 1 ? '' : 's'} · no configured limit`;
    if (users > max) return `${users}/${max} · OVER +${users - max}`;
    if (users === max) return `${users}/${max} · FULL`;
    return `${users}/${max} · ${max - users} left`;
  }

  function syncServers(option) {
    if (!server || !serverGroup) return;
    const isJellyfinPlan = option.dataset.service === 'jellyfin' || option.dataset.service === 'bundle';
    serverGroup.hidden = !isJellyfinPlan;
    let servers = [];
    try { servers = JSON.parse(option.dataset.servers || '[]'); } catch (_) { servers = []; }
    server.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic placement';
    server.appendChild(auto);
    if (!isJellyfinPlan) return;
    if (!servers.length) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'No eligible server found yet';
      none.disabled = true;
      server.appendChild(none);
      return;
    }
    for (const row of servers) {
      const opt = document.createElement('option');
      opt.value = row.id;
      opt.textContent = `${row.name} · ${row.health_status || 'unknown'} · ${capacityLabel(row)}`;
      server.appendChild(opt);
    }
  }

  function sync(resetCommercial) {
    const option = plan.options[plan.selectedIndex];
    if (!option) return;
    end.value = plusDays(start.value, option.dataset.days);
    if (resetCommercial) {
      if (amount) amount.value = option.dataset.amount || '0.00';
      if (currency) currency.value = option.dataset.currency || 'GBP';
      syncServers(option);
    }
  }

  plan.addEventListener('change', () => sync(true));
  start.addEventListener('change', () => sync(false));
})();
