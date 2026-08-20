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

  function promoteInlineSwitch(label) {
    if (!label || label.dataset.settingInlineReady === '1') return;
    const input=label.querySelector(':scope > input[type="checkbox"]');
    if(!input)return;
    label.dataset.settingInlineReady='1';
    label.classList.add('settingInlineSwitch');
    input.classList.add('settingSwitchInput');
  }

  function promoteLegacyToggles() {
    document.querySelectorAll('label.toggleRow, label.checkRow').forEach(promoteToggle);
    document.querySelectorAll('label.inlineToggle').forEach(promoteInlineSwitch);
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

  function compactNotificationEventGroups() {
    if (location.pathname === '/admin/notifications/preferences') {
      const form=document.querySelector('form[action="/admin/notifications/preferences"]');
      if(form && form.dataset.compactEvents!=='1'){
        form.dataset.compactEvents='1';
        [...form.children].filter(node=>node.matches?.('section.section')).forEach(section=>{
          const head=section.querySelector(':scope > .sectionHead');
          const heading=head?.querySelector('h2')?.textContent?.trim();
          if(!heading)return;
          const count=head.querySelector('.muted')?.textContent?.trim()||'';
          const details=document.createElement('details');details.className='settingEventDisclosure';
          const summary=document.createElement('summary');
          const strong=document.createElement('strong');strong.textContent=heading;
          const small=document.createElement('small');small.textContent=count||'Notification events';
          const edit=document.createElement('span');edit.textContent='Edit';
          summary.append(strong,small,edit);
          head.remove();
          form.insertBefore(details,section);
          section.classList.add('settingEventBody');
          details.append(summary,section);
        });
      }
    }
    if(location.pathname === '/admin/profile/notifications'){
      document.querySelectorAll('details.notificationEventGroup').forEach(group=>{
        group.removeAttribute('open');
        group.classList.add('settingEventDisclosure');
      });
    }
  }

  function compactConfiguredSecrets() {
    document.querySelectorAll('input[type="password"]').forEach(input => {
      if (input.closest('.settingSecretDisclosure')) return;
      const placeholder=(input.getAttribute('placeholder')||'').toLowerCase();
      if (!placeholder.includes('configured') || (!placeholder.includes('leave blank') && !placeholder.includes('keep'))) return;
      const parent=input.parentElement;
      if(!parent)return;
      const fieldLabel=input.previousElementSibling?.matches('label:not(.settingToggle)')?input.previousElementSibling:null;
      const clearControl=input.nextElementSibling?.matches('label.settingToggle, label.checkRow, label.toggleRow')?input.nextElementSibling:null;
      const labelText=(fieldLabel?.textContent||input.getAttribute('aria-label')||input.name||'Credential').replace(/\s+/g,' ').trim();
      const details=document.createElement('details');
      details.className='settingSecretDisclosure';
      const summary=document.createElement('summary');
      const name=document.createElement('span');name.textContent=labelText;
      const state=document.createElement('strong');state.textContent='Configured';
      const edit=document.createElement('em');edit.textContent='Edit';
      summary.append(name,state,edit);
      const body=document.createElement('div');body.className='settingSecretBody';
      parent.insertBefore(details,fieldLabel||input);
      details.append(summary,body);
      if(fieldLabel)body.appendChild(fieldLabel);
      body.appendChild(input);
      if(clearControl)body.appendChild(clearControl);
      input.setAttribute('aria-label',labelText);
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
    compactNotificationEventGroups();
    compactConfiguredSecrets();
    compactSettingsForms();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once:true});
  else run();
})();
