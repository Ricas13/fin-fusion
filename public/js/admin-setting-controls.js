'use strict';

(() => {
  function promoteToggle(label) {
    if (!label || label.dataset.settingToggleReady === '1') return;
    const input = label.querySelector(':scope > input[type="checkbox"]');
    if (!input) return;
    label.dataset.settingToggleReady = '1';
    label.classList.add('settingToggle');
    input.classList.add('settingToggleInput');

    let copy = [...label.children].find(node => node !== input && node.tagName !== 'INPUT');
    if (!copy) {
      const text = [...label.childNodes]
        .filter(node => node !== input && node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        copy = document.createElement('span');
        copy.textContent = text;
        [...label.childNodes].filter(node => node !== input && node.nodeType === Node.TEXT_NODE).forEach(node => node.remove());
        label.appendChild(copy);
      }
    }
    if (copy) {
      copy.classList.add('settingToggleCopy');
      if (!copy.querySelector('strong') && copy.children.length === 0) {
        const strong = document.createElement('strong');
        strong.textContent = (copy.textContent || '').trim();
        copy.replaceChildren(strong);
      }
    }
  }

  function promoteLegacyToggles() {
    document.querySelectorAll('label.toggleRow, label.checkRow').forEach(promoteToggle);
    document.querySelectorAll('.toggleGrid').forEach(grid => grid.classList.add('settingToggleGrid'));
  }

  function matrixLabel(input, table) {
    const cell = input.closest('td');
    const row = input.closest('tr');
    if (!cell || !row || !table) return input.name || 'Setting';
    const index = [...row.children].indexOf(cell);
    const header = table.querySelector(`thead th:nth-child(${index + 1})`);
    const event = row.querySelector('td:first-child strong')?.textContent?.trim() || row.querySelector('td:first-child')?.textContent?.trim() || 'event';
    return `${header?.textContent?.trim() || 'Setting'} for ${event}`;
  }

  function promoteBooleanMatrices() {
    const forms = [
      'form[action="/admin/notifications/preferences"]',
      'form[action="/admin/profile/notifications"]'
    ];
    document.querySelectorAll(forms.join(',')).forEach(form => {
      form.querySelectorAll('table').forEach(table => {
        if (!table.querySelector('input[type="checkbox"]')) return;
        table.classList.add('booleanMatrix');
        table.querySelectorAll('input[type="checkbox"]').forEach(input => {
          input.classList.add('settingSwitchInput');
          if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', matrixLabel(input, table));
          input.title = input.disabled ? 'Unavailable globally' : input.getAttribute('aria-label');
        });
      });
    });
  }

  function channelName(group) {
    return group.querySelector('.toggleRow strong, .settingToggle strong')?.textContent?.trim()
      || group.querySelector('label')?.textContent?.trim()
      || 'Messaging channel';
  }

  function compactGlobalNotificationChannels() {
    if (location.pathname !== '/admin/notifications/preferences') return;
    const form = document.querySelector('form[action="/admin/notifications/preferences/delivery"]');
    const grid = form?.querySelector(':scope > .formGrid');
    if (!grid || grid.dataset.compactChannels === '1') return;
    grid.dataset.compactChannels = '1';
    grid.classList.add('settingChannelGrid');

    [...grid.children].filter(group => group.classList.contains('formGroup')).forEach(group => {
      const sourceToggle = group.querySelector(':scope > label.toggleRow, :scope > label.settingToggle');
      const input = sourceToggle?.querySelector('input[type="checkbox"]');
      if (!input) return;
      const name = channelName(group);
      const details = document.createElement('details');
      details.className = 'settingChannelDisclosure';
      const summary = document.createElement('summary');
      const identity = document.createElement('span');
      identity.className = 'settingChannelIdentity';
      const strong = document.createElement('strong');
      strong.textContent = name;
      const meta = document.createElement('small');
      meta.textContent = 'Credentials and connection settings';
      identity.append(strong, meta);

      const switchLabel = document.createElement('label');
      switchLabel.className = 'settingSwitch settingChannelSwitch';
      input.classList.remove('settingToggleInput');
      input.classList.add('settingSwitchInput');
      switchLabel.appendChild(input);
      const track = document.createElement('span');
      track.setAttribute('aria-hidden', 'true');
      switchLabel.appendChild(track);
      switchLabel.addEventListener('click', event => event.stopPropagation());

      const edit = document.createElement('span');
      edit.className = 'settingChannelEdit';
      edit.textContent = 'Edit';
      summary.append(identity, switchLabel, edit);
      sourceToggle.remove();
      grid.insertBefore(details, group);
      details.append(summary, group);
      group.classList.add('settingChannelBody');
    });
  }

  function compactSettingsForms() {
    document.querySelectorAll('.settings-card form, .section form.formPanel').forEach(form => {
      if (form.querySelector('.settingToggle, .settingToggleGrid')) form.classList.add('compactSettingsForm');
    });
  }

  function run() {
    promoteLegacyToggles();
    promoteBooleanMatrices();
    compactGlobalNotificationChannels();
    compactSettingsForms();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once:true});
  else run();
})();
