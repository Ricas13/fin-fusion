'use strict';

(function () {
  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
  }

  function basicHeader(title = 'Basic Settings', copy = 'The settings and controls normally needed for this area.') {
    const wrap = node('div', 'adminSettingsBasicHeader');
    const text = node('div');
    text.append(node('h2', '', title), node('p', '', copy));
    wrap.append(text);
    return wrap;
  }

  function disclosure(id, title, summary, badgeText = '') {
    const details = node('details', 'adminSettingsDisclosure');
    if (id) details.id = id;
    const head = node('summary');
    const copy = node('span', 'adminSettingsSummaryCopy');
    copy.append(node('span', '', title), node('small', '', summary));
    head.append(copy);
    if (badgeText) head.append(node('span', title === 'Logs' ? 'adminSettingsLogsBadge' : 'adminSettingsAdvancedBadge', badgeText));
    details.append(head, node('div', 'adminSettingsDisclosureBody'));
    return details;
  }

  function bodyOf(details) { return details.querySelector(':scope > .adminSettingsDisclosureBody'); }

  function csrfToken() {
    return document.querySelector('input[name="_csrf"]')?.value || '';
  }

  async function json(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  function metadataSummary(metadata) {
    const data = metadata && typeof metadata === 'object' ? metadata : {};
    if (data.header && data.text) return `${data.header}: ${data.text}`;
    if (data.itemName) return String(data.itemName);
    if (data.enabled !== undefined) return `Enabled: ${data.enabled ? 'yes' : 'no'}`;
    if (data.sent !== undefined) return `Sent ${data.sent}/${data.attempted || data.sent}`;
    const keys = Object.keys(data).slice(0, 4);
    return keys.map(key => `${key}: ${String(data[key])}`).join(' · ') || '—';
  }

  function renderLogs(payload) {
    const list = node('div', 'adminSettingsLogList');
    const rows = [];
    for (const item of payload?.policy || []) rows.push({
      at: item.created_at,
      type: `Playback · ${item.decision || 'event'}`,
      detail: `${item.reason || 'policy'}${item.detail?.itemName ? ` · ${item.detail.itemName}` : ''}`
    });
    for (const item of payload?.audit || []) rows.push({
      at: item.created_at,
      type: String(item.action || 'Admin change'),
      detail: metadataSummary(item.metadata)
    });
    rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    if (!rows.length) return node('div', 'adminSettingsEmpty', 'No recent log entries.');
    for (const row of rows.slice(0, 60)) {
      const line = node('div', 'adminSettingsLogRow');
      const time = node('time', '', formatDate(row.at));
      const type = node('strong', '', row.type);
      const detail = node('span', 'muted', row.detail);
      line.append(time, type, detail);
      list.append(line);
    }
    return list;
  }

  function lazyLogs(details, url) {
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      const body = bodyOf(details);
      body.replaceChildren(node('div', 'adminSettingsEmpty', 'Loading logs…'));
      try { body.replaceChildren(renderLogs(await json(url))); }
      catch (error) { body.replaceChildren(node('div', 'notice error', error.message || 'Logs could not be loaded.')); }
    });
  }

  function revealHashTarget() {
    if (!location.hash) return;
    const target = document.querySelector(location.hash);
    if (!target) return;
    let parent = target.closest('details');
    while (parent) {
      parent.open = true;
      parent = parent.parentElement?.closest('details');
    }
  }

  function queryNoticeForServerPage() {
    if (!/^\/admin\/servers\/[0-9a-f-]{36}\/edit$/i.test(location.pathname)) return;
    const params = new URLSearchParams(location.search);
    const message = params.get('message');
    const error = params.get('error');
    if (!message && !error) return;
    const content = document.querySelector('.content');
    if (!content || content.querySelector('.notice')) return;
    const notice = node('div', `notice ${error ? 'error' : 'success'}`, error || message);
    const header = content.querySelector('.pageHeader');
    header?.insertAdjacentElement('afterend', notice);
  }

  function groupSecurity() {
    if (location.pathname !== '/admin/settings' || new URLSearchParams(location.search).get('section') !== 'security') return;
    const cards = [...document.querySelectorAll('section.settings-card')];
    if (!cards.length) return;
    // Session lifetimes, registration rate limits and private-network trust are
    // core Security settings and remain visible. Only infrequent housekeeping
    // is progressive disclosure here.
    const advancedTitles = new Set(['Abandoned activation cleanup']);
    const advancedCards = cards.filter(card => advancedTitles.has(card.querySelector('h3')?.textContent?.trim()));
    const first = cards[0];
    first.insertAdjacentElement('beforebegin', basicHeader('Basic Settings', 'Registration, verification, staff sign-in, session and network security controls used in normal administration.'));
    if (!advancedCards.length) return;
    const advanced = disclosure('advanced-settings', 'Advanced Settings', 'Infrequent security housekeeping and cleanup policy.', `${advancedCards.length} area`);
    const body = bodyOf(advanced);
    // Insert the disclosure while every original card is still in its original
    // parent. Moving the final card first can otherwise make that card a child
    // of `advanced`, and inserting `advanced` after its own descendant throws.
    cards[cards.length - 1].insertAdjacentElement('afterend', advanced);
    advancedCards.forEach(card => body.append(card));
  }

  function groupIntegrationsLanguage() {
    if (location.pathname !== '/admin/settings' || new URLSearchParams(location.search).get('section') !== 'integrations') return;
    for (const card of document.querySelectorAll('section.settings-card')) {
      const title = card.querySelector('h3');
      if (title?.textContent?.trim() === 'Advanced / optional integrations') title.textContent = 'Optional integrations';
    }
  }

  async function planMediaPolicy(planId, advancedBody) {
    const panel = node('section', 'adminSettingsInlinePanel');
    panel.append(node('h3', '', '4K Video Transcoding Kick'), node('p', '', 'Stops confirmed 4K video transcodes for this plan. 4K Direct Play remains allowed; uncertain resolution data is never kicked.'));
    advancedBody.prepend(panel);
    try {
      const state = await json(`/admin/media-controls/plan/${encodeURIComponent(planId)}/state`);
      const form = node('form');
      form.method = 'post';
      form.action = `/admin/media-controls/plan/${encodeURIComponent(planId)}/4k-transcode`;
      const csrf = node('input'); csrf.type = 'hidden'; csrf.name = '_csrf'; csrf.value = csrfToken();
      const toggle = node('label', 'toggleRow');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.name = 'enabled'; checkbox.checked = Boolean(state.kick4kTranscodes);
      const label = node('span');
      label.append(node('strong', '', 'Kick 4K video transcodes'), node('small', 'muted', 'A warning is sent to the active Jellyfin client before playback is stopped. Normal 1080p transcodes and 4K Direct Play are unaffected.'));
      toggle.append(checkbox, label);
      form.append(csrf, toggle);
      if (Number(state.liveEntitlements || 0) > 0) {
        const group = node('div', 'formGroup');
        const lab = node('label', '', 'Confirm live-plan change');
        const input = node('input', 'input'); input.name = 'confirmation'; input.autocomplete = 'off'; input.placeholder = `Type ${state.code} when changing this setting`;
        group.append(lab, input, node('div', 'inlineHelp', `${state.liveEntitlements} live entitlement${state.liveEntitlements === 1 ? '' : 's'} currently use this plan. Confirmation is required only when the value changes.`));
        form.append(group);
      }
      const row = node('div', 'buttonRow');
      const button = node('button', 'button', 'Save 4K transcode policy'); button.type = 'submit';
      row.append(button); form.append(row); panel.append(form);
    } catch (error) {
      panel.append(node('div', 'notice error', error.message || '4K transcode policy could not be loaded.'));
    }
  }

  function groupPlanEditor() {
    const match = location.pathname.match(/^\/admin\/plans\/([0-9a-f-]{36})\/edit$/i);
    if (!match) return;
    const grid = document.querySelector('.planControlGrid');
    if (!grid || grid.dataset.settingsGrouped === '1') return;
    grid.dataset.settingsGrouped = '1';
    grid.insertAdjacentElement('beforebegin', basicHeader('Basic Settings', 'Product, access, availability, libraries and normal commercial settings.'));

    const advancedNodes = ['delivery', 'lifecycle', 'requests'].map(id => document.getElementById(id)).filter(Boolean);
    const advanced = disclosure('advanced-settings', 'Advanced Settings', 'Placement, lifecycle, Jellyseerr policy and playback enforcement.', advancedNodes.length ? `${advancedNodes.length} configured areas` : 'Optional');
    const advancedBody = bodyOf(advanced);
    advancedNodes.forEach(item => advancedBody.append(item));
    grid.insertAdjacentElement('afterend', advanced);
    planMediaPolicy(match[1], advancedBody);

    const logs = disclosure('logs', 'Logs', 'Recent plan changes and 4K playback-policy events.', 'Collapsed');
    advanced.insertAdjacentElement('afterend', logs);
    lazyLogs(logs, `/admin/media-controls/plan/${encodeURIComponent(match[1])}/logs`);
  }

  function moveField(form, advancedBody, selector) {
    const element = form.querySelector(selector);
    const group = element?.closest('.formGroup, .toggleRow, .securityNote');
    if (group && !advancedBody.contains(group)) advancedBody.append(group);
  }

  async function serverMessagePanel(serverId, beforeNode) {
    const panel = node('section', 'section adminSettingsBasicServer');
    const head = node('div', 'sectionHead');
    head.append(node('h2', '', 'Send Jellyfin message'), node('span', 'muted', 'Active clients only'));
    panel.append(head);
    const formPanel = node('div', 'formPanel');
    panel.append(formPanel);
    beforeNode?.insertAdjacentElement('beforebegin', panel);
    try {
      const state = await json(`/admin/media-controls/server/${encodeURIComponent(serverId)}/state`);
      if (!state.supportsMessaging) {
        formPanel.append(node('div', 'adminSettingsEmpty', 'In-client messaging is currently available for Jellyfin servers only.'));
        return;
      }
      if (state.messagingError) {
        formPanel.append(node('div', 'notice warn', state.messagingError));
        return;
      }
      const form = node('form'); form.method = 'post'; form.action = `/admin/media-controls/server/${encodeURIComponent(serverId)}/message`;
      const csrf = node('input'); csrf.type = 'hidden'; csrf.name = '_csrf'; csrf.value = csrfToken(); form.append(csrf);
      const audience = node('div', 'formGroup'); audience.append(node('label', '', 'Audience'));
      const select = node('select', 'input'); select.name = 'customerId';
      const all = node('option', '', `All active managed users (${state.activeSessions})`); all.value = ''; select.append(all);
      for (const target of state.targets || []) {
        const option = node('option', '', `${target.label} · ${target.sessions} active session${target.sessions === 1 ? '' : 's'}`);
        option.value = target.customerId; select.append(option);
      }
      audience.append(select, node('div', 'adminMessageAudienceMeta', 'Jellyfin messages are live client pop-ups, not an offline inbox. Users without an active Jellyfin session will not receive them.'));
      const titleGroup = node('div', 'formGroup'); titleGroup.append(node('label', '', 'Message title'));
      const title = node('input', 'input'); title.name = 'header'; title.maxLength = 80; title.value = 'Message from administrator'; title.required = true; titleGroup.append(title);
      const textGroup = node('div', 'formGroup'); textGroup.append(node('label', '', 'Message'));
      const text = node('textarea', 'input'); text.name = 'text'; text.rows = 4; text.maxLength = 500; text.required = true; text.placeholder = 'Type the message shown in Jellyfin…'; textGroup.append(text);
      const timeoutGroup = node('div', 'formGroup'); timeoutGroup.append(node('label', '', 'Display time'));
      const timeout = node('input', 'input'); timeout.type = 'number'; timeout.name = 'timeoutSeconds'; timeout.min = '3'; timeout.max = '30'; timeout.value = '8'; timeoutGroup.append(timeout, node('div', 'inlineHelp', 'Seconds before Jellyfin dismisses the pop-up.'));
      const fields = node('div', 'formGrid'); fields.append(audience, titleGroup, textGroup, timeoutGroup); form.append(fields);
      const row = node('div', 'buttonRow'); const submit = node('button', 'button', 'Send message'); submit.type = 'submit'; row.append(submit); form.append(row); formPanel.append(form);
    } catch (error) {
      formPanel.append(node('div', 'notice error', error.message || 'Active Jellyfin sessions could not be loaded.'));
    }
  }

  function groupServerEditor() {
    const match = location.pathname.match(/^\/admin\/servers\/([0-9a-f-]{36})\/edit$/i);
    const isNew = location.pathname === '/admin/servers/new';
    if (!match && !isNew) return;
    const configSection = [...document.querySelectorAll('section.section')].find(section => section.querySelector('.sectionHead h2')?.textContent?.trim() === 'Server configuration');
    const form = configSection?.querySelector('form');
    if (!configSection || !form || form.dataset.settingsGrouped === '1') return;
    form.dataset.settingsGrouped = '1';
    const title = configSection.querySelector('.sectionHead h2'); if (title) title.textContent = 'Basic Settings';

    const advanced = disclosure('advanced-settings', 'Advanced Settings', 'Address overrides, placement tuning and specialist eligibility controls.', 'Collapsed');
    const advancedBody = bodyOf(advanced);
    for (const selector of ['#slug', '#location', '#publicUrl', '#priority', 'input[name="trialEnabled"]', 'input[name="paidEnabled"]', '#confirmation']) moveField(form, advancedBody, selector);
    const security = form.querySelector('.securityNote.standalone'); if (security) advancedBody.append(security);
    const buttons = form.querySelector('.buttonRow');
    if (buttons) form.insertBefore(advanced, buttons); else form.append(advanced);

    if (!match) return;
    const connectivity = [...document.querySelectorAll('section.section')].find(section => section.querySelector('.sectionHead h2')?.textContent?.trim() === 'Connectivity');
    serverMessagePanel(match[1], connectivity || configSection.nextElementSibling);
    const logs = disclosure('logs', 'Logs', 'Recent server changes, administrator messages and playback-policy events.', 'Collapsed');
    (connectivity || configSection).insertAdjacentElement('afterend', logs);
    lazyLogs(logs, `/admin/media-controls/server/${encodeURIComponent(match[1])}/logs`);
  }

  function groupPayments() {
    if (location.pathname !== '/admin/payments') return;
    const provider = document.getElementById('provider-setup');
    const heading = provider?.querySelector('h2');
    if (heading) heading.textContent = 'Basic Settings';
    const description = provider?.querySelector('.muted');
    if (description) description.textContent = 'Provider status, required credentials, callback readiness and connection tests.';
    for (const config of document.querySelectorAll('.integrationConfig')) {
      config.removeAttribute('open');
      config.classList.add('adminSettingsDisclosure');
      const first = config.querySelector('summary span:first-child');
      if (first && !/^Advanced Settings/.test(first.textContent || '')) first.textContent = `Advanced Settings · ${String(first.textContent || '').replace(/^Configure\s+/i, '')}`;
    }

    const diagnostics = document.getElementById('provider-diagnostics');
    if (!diagnostics || diagnostics.dataset.settingsGrouped === '1') return;
    diagnostics.dataset.settingsGrouped = '1';
    const visibleFailure = diagnostics.querySelector('.operatorCallout.bad');
    const logs = disclosure('logs', 'Logs', 'Provider callback history, processing results and troubleshooting evidence.', 'Collapsed');
    logs.classList.add('providerLogsDisclosure');
    const logsBody = bodyOf(logs);
    for (const child of [...diagnostics.children]) {
      if (child === visibleFailure) continue;
      logsBody.append(child);
    }
    diagnostics.append(logs);
  }

  function init() {
    queryNoticeForServerPage();
    groupSecurity();
    groupIntegrationsLanguage();
    groupPlanEditor();
    groupServerEditor();
    groupPayments();
    requestAnimationFrame(revealHashTarget);
    setTimeout(revealHashTarget, 200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();