'use strict';

(function () {
  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text != null) item.textContent = text;
    return item;
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

  function bodyOf(details) {
    return details.querySelector(':scope > .adminSettingsDisclosureBody, :scope > .planDetailsBody');
  }

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
      type: item.decision || 'event',
      detail: item.reason || 'playback policy'
    });
    for (const item of payload?.audit || []) rows.push({
      at: item.created_at,
      type: 'admin',
      detail: `${String(item.action || 'change')}${item.metadata ? ` · ${metadataSummary(item.metadata)}` : ''}`
    });
    rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    if (!rows.length) return node('div', 'adminSettingsEmpty', 'No recent troubleshooting entries.');
    for (const row of rows.slice(0, 60)) {
      const line = node('div', 'adminSettingsLogRow');
      line.append(node('time', '', formatDate(row.at)), node('strong', '', row.type), node('span', 'muted', row.detail));
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
      body.replaceChildren(node('div', 'adminSettingsEmpty', 'Loading…'));
      try { body.replaceChildren(renderLogs(await json(url))); }
      catch (error) { body.replaceChildren(node('div', 'notice error', error.message || 'Logs could not be loaded.')); }
    });
  }

  function revealHashTarget() {
    if (!location.hash) return;
    const target = document.querySelector(location.hash);
    if (!target) return;
    let parent = target.matches('details') ? target : target.closest('details');
    while (parent) {
      parent.open = true;
      parent = parent.parentElement?.closest('details');
    }
    target.scrollIntoView?.({ block: 'start' });
  }

  function markBasic(card, copy = '') {
    if (!card || card.dataset.basicSettingsMarked === '1') return;
    card.dataset.basicSettingsMarked = '1';
    const head = card.querySelector(':scope > .planConfigHead, :scope > .sectionHead, :scope > .card-header') || card.querySelector('.planConfigHead, .sectionHead, .card-header');
    if (!head) return;
    const grade = node('span', 'adminSettingsCardGrade', 'Basic Settings');
    if (copy) grade.title = copy;
    head.append(grade);
  }

  function promoteExistingAdvanced(card, id, summaryText) {
    const details = card?.querySelector('details.planCardDetails');
    if (!details) return null;
    details.id = id;
    details.removeAttribute('open');
    details.classList.add('adminSettingsDisclosure', 'adminSettingsCardAdvanced');
    const summary = details.querySelector(':scope > summary');
    const original = summary?.textContent?.trim() || summaryText;
    if (summary) {
      const copy = node('span', 'adminSettingsSummaryCopy');
      copy.append(node('span', '', 'Advanced Settings'), node('small', '', original));
      summary.replaceChildren(copy, node('span', 'adminSettingsAdvancedBadge', 'Expand'));
    }
    const body = details.querySelector(':scope > .planDetailsBody');
    body?.classList.add('adminSettingsDisclosureBody');
    return details;
  }

  function ensureCardAdvanced(card, id, summaryText) {
    const existing = promoteExistingAdvanced(card, id, summaryText);
    if (existing) return existing;
    const advanced = disclosure(id, 'Advanced Settings', summaryText, 'Expand');
    advanced.classList.add('adminSettingsCardAdvanced');
    const form = card?.querySelector('form');
    const buttons = form?.querySelector(':scope > .buttonRow');
    if (buttons) form.insertBefore(advanced, buttons);
    else if (form) form.append(advanced);
    else card?.append(advanced);
    return advanced;
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
    for (const card of document.querySelectorAll('section.settings-card')) {
      markBasic(card, 'Security controls remain visible in their owning card.');
    }
  }

  function groupIntegrationsLanguage() {
    if (location.pathname !== '/admin/settings' || new URLSearchParams(location.search).get('section') !== 'integrations') return;
    for (const card of document.querySelectorAll('section.settings-card')) {
      markBasic(card);
      const title = card.querySelector('h3');
      if (title?.textContent?.trim() === 'Advanced / optional integrations') title.textContent = 'Optional integrations';
    }
  }

  function formGroup(label, input) {
    const group = node('div', 'formGroup');
    group.append(node('label', '', label), input);
    return group;
  }

  async function planMediaPolicy(planId, advancedBody) {
    const connection = node('section', 'adminSettingsInlinePanel');
    connection.append(
      node('h3', '', 'Playback connection limits'),
      node('p', '', 'Optional active IP and connected-device caps. The active playback-session limit remains the Basic Settings value above. Missing or uncertain identity data is never kicked.')
    );
    advancedBody.prepend(connection);

    const fourK = node('section', 'adminSettingsInlinePanel');
    fourK.append(
      node('h3', '', '4K Video Transcoding Kick'),
      node('p', '', 'Stops confirmed 4K video transcodes for this plan. 4K Direct Play remains allowed; uncertain resolution data is never kicked.')
    );
    advancedBody.append(fourK);

    try {
      const state = await json(`/admin/media-controls/plan/${encodeURIComponent(planId)}/state`);

      const connectionForm = node('form');
      connectionForm.method = 'post';
      connectionForm.action = `/admin/media-controls/plan/${encodeURIComponent(planId)}/connection-policy`;
      const connectionCsrf = node('input'); connectionCsrf.type = 'hidden'; connectionCsrf.name = '_csrf'; connectionCsrf.value = csrfToken();
      connectionForm.append(connectionCsrf);

      const ip = node('input', 'input'); ip.type = 'number'; ip.name = 'ipLimit'; ip.min = '0'; ip.max = '200'; ip.value = state.ipLimit == null ? '0' : String(state.ipLimit);
      const ipGroup = formGroup('Active IP addresses', ip);
      ipGroup.append(node('div', 'inlineHelp', '0 = unlimited. Only distinct IPs currently playing count.'));
      const device = node('input', 'input'); device.type = 'number'; device.name = 'deviceLimit'; device.min = '0'; device.max = '200'; device.value = state.deviceLimit == null ? '0' : String(state.deviceLimit);
      const deviceGroup = formGroup('Connected devices', device);
      deviceGroup.append(node('div', 'inlineHelp', '0 = unlimited. Distinct active Device IDs count while playing.'));
      const limits = node('div', 'formGrid'); limits.append(ipGroup, deviceGroup); connectionForm.append(limits);

      const reminder = node('label', 'toggleRow');
      const reminderInput = node('input'); reminderInput.type = 'checkbox'; reminderInput.name = 'paygExpiryMessagesEnabled'; reminderInput.checked = state.paygExpiryMessagesEnabled !== false;
      const reminderCopy = node('span');
      reminderCopy.append(
        node('strong', '', 'Pay As You Go expiry messages'),
        node('small', 'muted', 'At 7 days, 1 day and on the expiry day: one in-client message per day, sent after 30 seconds of active playback.')
      );
      reminder.append(reminderInput, reminderCopy); connectionForm.append(reminder);

      if (Number(state.liveEntitlements || 0) > 0) {
        const confirmation = node('input', 'input'); confirmation.name = 'confirmation'; confirmation.autocomplete = 'off'; confirmation.placeholder = `Type ${state.code} when changing an IP/device limit`;
        const confirmationGroup = formGroup('Confirm live-plan limit change', confirmation);
        confirmationGroup.append(node('div', 'inlineHelp', `${state.liveEntitlements} live entitlement${state.liveEntitlements === 1 ? '' : 's'} use this plan. Confirmation is required only when an IP or device limit changes.`));
        connectionForm.append(confirmationGroup);
      }
      const connectionButtons = node('div', 'buttonRow');
      const connectionSave = node('button', 'button', 'Save connection policy'); connectionSave.type = 'submit'; connectionButtons.append(connectionSave);
      connectionForm.append(connectionButtons);
      connection.append(connectionForm);

      const fourKForm = node('form');
      fourKForm.method = 'post';
      fourKForm.action = `/admin/media-controls/plan/${encodeURIComponent(planId)}/4k-transcode`;
      const fourKCsrf = node('input'); fourKCsrf.type = 'hidden'; fourKCsrf.name = '_csrf'; fourKCsrf.value = csrfToken();
      const toggle = node('label', 'toggleRow');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.name = 'enabled'; checkbox.checked = Boolean(state.kick4kTranscodes);
      const label = node('span');
      label.append(node('strong', '', 'Kick 4K video transcodes'), node('small', 'muted', 'A Jellyfin/Emby warning is sent to the active client before playback is stopped. Normal 1080p transcodes and 4K Direct Play are unaffected.'));
      toggle.append(checkbox, label); fourKForm.append(fourKCsrf, toggle);
      if (Number(state.liveEntitlements || 0) > 0) {
        const confirmation = node('input', 'input'); confirmation.name = 'confirmation'; confirmation.autocomplete = 'off'; confirmation.placeholder = `Type ${state.code} when changing this setting`;
        const group = formGroup('Confirm live-plan change', confirmation);
        group.append(node('div', 'inlineHelp', `${state.liveEntitlements} live entitlement${state.liveEntitlements === 1 ? '' : 's'} currently use this plan. Confirmation is required only when the value changes.`));
        fourKForm.append(group);
      }
      const fourKButtons = node('div', 'buttonRow');
      const fourKSave = node('button', 'button', 'Save 4K transcode policy'); fourKSave.type = 'submit'; fourKButtons.append(fourKSave);
      fourKForm.append(fourKButtons); fourK.append(fourKForm);
    } catch (error) {
      connection.append(node('div', 'notice error', error.message || 'Playback connection policy could not be loaded.'));
      fourK.append(node('div', 'notice error', error.message || '4K transcode policy could not be loaded.'));
    }
  }

  function relabelActiveSessions(accessCard) {
    const input = accessCard?.querySelector('input[name="streams"]');
    const group = input?.closest('.formGroup');
    const label = group?.querySelector('label');
    if (label) label.textContent = 'Active playback sessions';
    const help = group?.querySelector('.inlineHelp');
    if (help) help.textContent = 'Maximum simultaneous playing sessions when the concurrent-session access model is selected.';
    const mode = accessCard?.querySelector('select[name="jellyfinAccessModel"]');
    for (const option of mode?.options || []) {
      if (option.value === 'concurrent_streams') option.textContent = 'Active playback sessions';
      if (option.value === 'household_network') option.textContent = 'Household network / IP lease';
    }
  }

  function groupPlanEditor() {
    const match = location.pathname.match(/^\/admin\/plans\/([0-9a-f-]{36})\/edit$/i);
    if (!match) return;
    const grid = document.querySelector('.planControlGrid');
    if (!grid || grid.dataset.settingsGrouped === '1') return;
    grid.dataset.settingsGrouped = '1';

    for (const card of grid.querySelectorAll(':scope > .planConfigCard')) {
      markBasic(card, 'Normal plan controls stay visible.');
      const existing = card.querySelector('details.planCardDetails');
      if (existing) promoteExistingAdvanced(card, `${card.id || 'card'}-advanced-settings`, 'Specialist controls for this card');
    }

    const accessCard = document.getElementById('access');
    relabelActiveSessions(accessCard);
    const accessAdvanced = ensureCardAdvanced(accessCard, 'access-advanced-settings', 'IP/device limits, Pay As You Go reminders, media permissions and 4K playback enforcement.');
    const accessAdvancedBody = bodyOf(accessAdvanced);
    if (accessAdvancedBody) planMediaPolicy(match[1], accessAdvancedBody);

    const logs = disclosure('logs', 'Logs', 'Troubleshooting only. Recent admin changes, playback kicks and expiry-message results.', 'Collapsed');
    logs.classList.add('adminSettingsPageLogs');
    grid.insertAdjacentElement('afterend', logs);
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
    const title = node('h2', '', 'Send media-server message');
    head.append(title, node('span', 'adminSettingsCardGrade', 'Basic Settings'));
    panel.append(head);
    const formPanel = node('div', 'formPanel');
    panel.append(formPanel);
    beforeNode?.insertAdjacentElement('beforebegin', panel);
    try {
      const state = await json(`/admin/media-controls/server/${encodeURIComponent(serverId)}/state`);
      const providerLabel = state.providerLabel || 'Media server';
      title.textContent = `Send ${providerLabel} message`;
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
      audience.append(select, node('div', 'adminMessageAudienceMeta', `${providerLabel} messages are live client pop-ups, not an offline inbox. Users without an active session will not receive them.`));
      const titleGroup = node('div', 'formGroup'); titleGroup.append(node('label', '', 'Message title'));
      const messageTitle = node('input', 'input'); messageTitle.name = 'header'; messageTitle.maxLength = 80; messageTitle.value = 'Message from administrator'; messageTitle.required = true; titleGroup.append(messageTitle);
      const textGroup = node('div', 'formGroup'); textGroup.append(node('label', '', 'Message'));
      const text = node('textarea', 'input'); text.name = 'text'; text.rows = 4; text.maxLength = 500; text.required = true; text.placeholder = `Type the message shown in ${providerLabel}…`; textGroup.append(text);
      const timeoutGroup = node('div', 'formGroup'); timeoutGroup.append(node('label', '', 'Display time'));
      const timeout = node('input', 'input'); timeout.type = 'number'; timeout.name = 'timeoutSeconds'; timeout.min = '3'; timeout.max = '30'; timeout.value = '8'; timeoutGroup.append(timeout, node('div', 'inlineHelp', `Seconds before ${providerLabel} dismisses the pop-up.`));
      const fields = node('div', 'formGrid'); fields.append(audience, titleGroup, textGroup, timeoutGroup); form.append(fields);
      const row = node('div', 'buttonRow'); const submit = node('button', 'button', 'Send message'); submit.type = 'submit'; row.append(submit); form.append(row); formPanel.append(form);
    } catch (error) {
      formPanel.append(node('div', 'notice error', error.message || 'Active media-server sessions could not be loaded.'));
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
    markBasic(configSection, 'Normal server configuration stays visible.');

    const advanced = disclosure('server-advanced-settings', 'Advanced Settings', 'Address overrides, placement tuning and specialist eligibility controls.', 'Expand');
    advanced.classList.add('adminSettingsCardAdvanced');
    const advancedBody = bodyOf(advanced);
    for (const selector of ['#slug', '#location', '#publicUrl', '#priority', 'input[name="trialEnabled"]', 'input[name="paidEnabled"]', '#confirmation']) moveField(form, advancedBody, selector);
    const security = form.querySelector('.securityNote.standalone'); if (security) advancedBody.append(security);
    const buttons = form.querySelector(':scope > .buttonRow');
    if (buttons) form.insertBefore(advanced, buttons); else form.append(advanced);

    if (!match) return;
    const connectivity = [...document.querySelectorAll('section.section')].find(section => section.querySelector('.sectionHead h2')?.textContent?.trim() === 'Connectivity');
    serverMessagePanel(match[1], connectivity || configSection.nextElementSibling);
    const logs = disclosure('logs', 'Logs', 'Troubleshooting only. Recent server changes, messages and playback-policy results.', 'Collapsed');
    logs.classList.add('adminSettingsPageLogs');
    const content = document.querySelector('.content');
    if (content) content.append(logs); else (connectivity || configSection).insertAdjacentElement('afterend', logs);
    lazyLogs(logs, `/admin/media-controls/server/${encodeURIComponent(match[1])}/logs`);
  }

  function groupPayments() {
    if (location.pathname !== '/admin/payments') return;
    const provider = document.getElementById('provider-setup');
    if (provider) markBasic(provider, 'Provider status and normal connection controls.');
    for (const config of document.querySelectorAll('.integrationConfig')) {
      config.removeAttribute('open');
      config.classList.add('adminSettingsDisclosure', 'adminSettingsCardAdvanced');
      const first = config.querySelector('summary span:first-child');
      if (first && !/^Advanced Settings/.test(first.textContent || '')) first.textContent = `Advanced Settings · ${String(first.textContent || '').replace(/^Configure\s+/i, '')}`;
    }

    const diagnostics = document.getElementById('provider-diagnostics');
    if (!diagnostics || diagnostics.dataset.settingsGrouped === '1') return;
    diagnostics.dataset.settingsGrouped = '1';
    const visibleFailure = diagnostics.querySelector('.operatorCallout.bad');
    const logs = disclosure('logs', 'Logs', 'Troubleshooting only. Provider callback and processing history.', 'Collapsed');
    logs.classList.add('providerLogsDisclosure', 'adminSettingsPageLogs');
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
