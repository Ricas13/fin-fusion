'use strict';

(() => {
  if (typeof document === 'undefined') return;

  const TEXT_DEBOUNCE_MS = 550;
  let submitTimer = null;

  function namedControl(group) {
    return group?.querySelector('input[name]:not([type="hidden"]),select[name],textarea[name]') || null;
  }

  function formGroup(form, name) {
    const control = form.elements.namedItem(name);
    return control instanceof Element ? control.closest('.formGroup') : null;
  }

  function cleanLabel(group, control) {
    const label = control?.labels?.[0] || group?.querySelector('label');
    return String(label?.textContent || control?.getAttribute('aria-label') || control?.name || 'Filter')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function selectedText(control) {
    if (control instanceof HTMLSelectElement) {
      return String(control.options[control.selectedIndex]?.textContent || '').trim();
    }
    if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) {
      return control.checked ? String(control.value || 'On') : '';
    }
    return String(control?.value || '').trim();
  }

  function hasValue(control) {
    if (!control) return false;
    if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) return control.checked;
    return String(control.value || '').trim() !== '';
  }

  function requestFilterSubmit(form) {
    if (!form || form.dataset.filterSubmitting === '1') return;
    window.clearTimeout(submitTimer);
    form.dataset.filterSubmitting = '1';
    form.requestSubmit();
  }

  function scheduleFilterSubmit(form) {
    window.clearTimeout(submitTimer);
    submitTimer = window.setTimeout(() => requestFilterSubmit(form), TEXT_DEBOUNCE_MS);
  }

  function bindAutoApply(form, controls) {
    for (const control of controls) {
      if (!control || control.dataset.filterBound === '1' || control.disabled) continue;
      control.dataset.filterBound = '1';
      const type = control instanceof HTMLInputElement ? String(control.type || 'text').toLowerCase() : '';
      const isText = control instanceof HTMLTextAreaElement || (control instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel'].includes(type));
      if (isText) {
        control.addEventListener('input', () => scheduleFilterSubmit(form));
        control.addEventListener('keydown', event => {
          if (event.key === 'Enter') window.clearTimeout(submitTimer);
        });
      } else {
        control.addEventListener('change', () => requestFilterSubmit(form));
      }
    }
  }

  function chipLabel(control, group) {
    const label = cleanLabel(group, control);
    const value = selectedText(control);
    if (!value) return '';
    if (/^(any|all|all products|all statuses|all events)$/i.test(value)) return '';
    return `${label}: ${value}`;
  }

  function buildChips(form, groups, shell, onClear) {
    const chips = document.createElement('div');
    chips.className = 'adminFilterChips';
    chips.setAttribute('aria-label', 'Active filters');
    for (const group of groups) {
      const control = namedControl(group);
      if (!control || !hasValue(control)) continue;
      const text = chipLabel(control, group);
      if (!text) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'adminFilterChip';
      chip.innerHTML = `${text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))} <span aria-hidden="true">×</span>`;
      chip.setAttribute('aria-label', `Remove ${cleanLabel(group, control)} filter`);
      chip.addEventListener('click', () => {
        if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) control.checked = false;
        else control.value = '';
        onClear?.(control);
        requestFilterSubmit(form);
      });
      chips.appendChild(chip);
    }
    if (chips.childElementCount) shell.appendChild(chips);
  }

  function customerConfig(form) {
    if (!form.matches('form.compactFilterForm[action="/admin/users"]')) return null;
    return {
      primary: ['q', 'service', 'status', 'plan', 'server'],
      advanced: ['accountStatus', 'paymentProvider', 'reconciliationStatus', 'hasOverride', 'library', 'expiryFrom', 'expiryTo', 'lastActiveFrom', 'lastActiveTo', 'registeredFrom', 'registeredTo'],
      resetHref: '/admin/users',
      searchNames: new Set(['q']),
      customerExpiryPreset: true
    };
  }

  function inferredConfig(form) {
    const groups = Array.from(form.querySelectorAll('.formGroup')).filter(group => namedControl(group));
    const names = groups.map(group => namedControl(group)?.name).filter(Boolean);
    if (names.length < 2) return null;
    const primaryFromData = String(form.dataset.filterPrimary || '').split(',').map(v => v.trim()).filter(Boolean);
    const advancedFromData = String(form.dataset.filterAdvanced || '').split(',').map(v => v.trim()).filter(Boolean);
    const primary = primaryFromData.length ? primaryFromData : names.slice(0, Math.min(3, names.length));
    const advanced = advancedFromData.length ? advancedFromData : names.filter(name => !primary.includes(name));
    const searchNames = new Set(names.filter(name => {
      const control = form.elements.namedItem(name);
      return control instanceof HTMLInputElement && ['search', 'text'].includes(String(control.type || 'text').toLowerCase());
    }).slice(0, 1));
    return { primary, advanced, resetHref: form.action, searchNames };
  }

  function addCustomerExpiryPreset(form, api) {
    const from = form.elements.namedItem('expiryFrom');
    const to = form.elements.namedItem('expiryTo');
    if (!(from instanceof HTMLInputElement) || !(to instanceof HTMLInputElement) || !api.advancedGrid) return;
    const group = document.createElement('div');
    group.className = 'formGroup adminFilterExpiryPreset';
    group.innerHTML = '<label for="adminCustomerExpiryPreset">Expiry</label><select class="input" id="adminCustomerExpiryPreset"><option value="any">Expiry: Any time</option><option value="today">Expiry: Today</option><option value="7">Expiry: Next 7 days</option><option value="30">Expiry: Next 30 days</option><option value="expired">Expiry: Expired</option><option value="custom">Expiry: Custom range</option></select>';
    api.advancedGrid.prepend(group);
    const preset = group.querySelector('select');
    if (from.value || to.value) preset.value = 'custom';
    const iso = date => {
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 10);
    };
    preset.addEventListener('change', () => {
      const today = new Date();
      const value = preset.value;
      if (value === 'custom') {
        api.showAdvanced();
        from.focus();
        return;
      }
      from.value = '';
      to.value = '';
      if (value === 'today') from.value = to.value = iso(today);
      if (value === '7' || value === '30') {
        from.value = iso(today);
        const end = new Date(today);
        end.setDate(end.getDate() + Number(value));
        to.value = iso(end);
      }
      if (value === 'expired') to.value = iso(today);
      requestFilterSubmit(form);
    });
    api.onClear = control => {
      if (['expiryFrom', 'expiryTo'].includes(control?.name)) preset.value = 'custom';
    };
  }

  function enhanceForm(form, explicitConfig = null) {
    if (!form || form.dataset.adminFilterEnhanced === '1') return null;
    if (String(form.method || 'get').toLowerCase() !== 'get') return null;
    if (form.matches('.adminQuickFind,[data-native-submit="true"]')) return null;
    const originalGrid = form.querySelector(':scope > .formGrid') || form.querySelector('.formGrid');
    if (!originalGrid) return null;
    const config = explicitConfig || customerConfig(form) || inferredConfig(form);
    if (!config) return null;

    const primaryGroups = config.primary.map(name => formGroup(form, name)).filter(Boolean);
    const advancedGroups = config.advanced.map(name => formGroup(form, name)).filter(Boolean).filter(group => !primaryGroups.includes(group));
    if (!primaryGroups.length) return null;

    form.dataset.adminFilterEnhanced = '1';
    form.classList.add('adminFilterForm');
    const shell = document.createElement('div');
    shell.className = 'adminFilterShell';
    const toolbar = document.createElement('div');
    toolbar.className = 'adminFilterToolbar';
    toolbar.setAttribute('role', 'search');
    toolbar.setAttribute('aria-label', 'Filters');

    for (const group of primaryGroups) {
      const control = namedControl(group);
      if (control && config.searchNames?.has(control.name)) group.classList.add('adminFilterSearch');
      toolbar.appendChild(group);
    }

    const actions = document.createElement('div');
    actions.className = 'adminFilterActions';
    let more = null;
    let advanced = null;
    let advancedGrid = null;
    if (advancedGroups.length) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'button secondary';
      more.textContent = 'More filters';
      more.setAttribute('aria-expanded', 'false');
      actions.appendChild(more);
      advanced = document.createElement('div');
      advanced.className = 'adminFilterAdvanced';
      advanced.hidden = true;
      advancedGrid = document.createElement('div');
      advancedGrid.className = 'adminFilterAdvancedGrid';
      advancedGroups.forEach(group => advancedGrid.appendChild(group));
      advanced.appendChild(advancedGrid);
    }

    const reset = document.createElement('a');
    reset.className = 'button secondary';
    reset.href = config.resetHref || form.action;
    reset.textContent = 'Reset';
    actions.appendChild(reset);
    toolbar.appendChild(actions);
    shell.appendChild(toolbar);
    if (advanced) shell.appendChild(advanced);

    originalGrid.replaceWith(shell);
    const originalButtons = form.querySelector(':scope > .buttonRow');
    originalButtons?.remove();
    for (const button of form.querySelectorAll(':scope > button')) {
      if (/^(apply|filter|search)/i.test(String(button.textContent || '').trim())) button.remove();
    }

    const showAdvanced = () => {
      if (!advanced || !more) return;
      advanced.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      more.textContent = 'Fewer filters';
    };
    const hideAdvanced = () => {
      if (!advanced || !more) return;
      advanced.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      more.textContent = 'More filters';
    };
    if (advancedGroups.some(group => hasValue(namedControl(group)))) showAdvanced();
    more?.addEventListener('click', () => advanced?.hidden ? showAdvanced() : hideAdvanced());

    const controls = [...primaryGroups, ...advancedGroups].map(namedControl).filter(Boolean);
    bindAutoApply(form, controls);
    const api = { shell, toolbar, advanced, advancedGrid, more, showAdvanced, hideAdvanced, onClear: null };
    if (config.customerExpiryPreset) addCustomerExpiryPreset(form, api);
    buildChips(form, [...primaryGroups, ...advancedGroups], shell, control => api.onClear?.(control));
    return api;
  }

  function enhancePlanFilters() {
    const source = document.querySelector('[data-plan-filters]');
    if (!source || source.dataset.adminFilterEnhanced === '1') return;
    const findGroup = selector => source.querySelector(selector)?.closest('label');
    const primary = ['[data-plan-search]', '[data-plan-status]', '[data-plan-delivery]'].map(findGroup).filter(Boolean);
    const secondary = ['[data-plan-price]', '[data-plan-billing]', '[data-plan-server]'].map(findGroup).filter(Boolean);
    if (!primary.length) return;
    source.dataset.adminFilterEnhanced = '1';
    const shell = document.createElement('div');
    shell.className = 'adminFilterShell adminFilterLocal';
    const toolbar = document.createElement('div');
    toolbar.className = 'adminFilterToolbar';
    primary.forEach(group => toolbar.appendChild(group));
    primary[0]?.classList.add('adminFilterSearch');
    const actions = document.createElement('div');
    actions.className = 'adminFilterActions';
    const advanced = document.createElement('div');
    advanced.className = 'adminFilterAdvanced';
    advanced.hidden = true;
    const grid = document.createElement('div');
    grid.className = 'adminFilterAdvancedGrid';
    secondary.forEach(group => grid.appendChild(group));
    advanced.appendChild(grid);
    if (secondary.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'button secondary';
      more.textContent = 'More filters';
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => {
        advanced.hidden = !advanced.hidden;
        more.setAttribute('aria-expanded', String(!advanced.hidden));
        more.textContent = advanced.hidden ? 'More filters' : 'Fewer filters';
      });
      actions.appendChild(more);
    }
    const reset = source.querySelector('[data-plan-reset]');
    if (reset) actions.appendChild(reset);
    toolbar.appendChild(actions);
    shell.append(toolbar);
    if (secondary.length) shell.append(advanced);
    source.replaceWith(shell);
  }

  function eligibleGetForms() {
    return Array.from(document.querySelectorAll('form[method="get"],form:not([method])')).filter(form => {
      if (form.matches('.adminQuickFind,[data-native-submit="true"]')) return false;
      if (!form.querySelector('.formGrid')) return false;
      let path = '';
      try { path = new URL(form.action || location.href, location.href).pathname; } catch { return false; }
      if (!path.startsWith('/admin/')) return false;
      return form.querySelectorAll('input[name]:not([type="hidden"]),select[name],textarea[name]').length >= 2;
    });
  }

  window.AdminFilterBars = { enhanceForm, requestFilterSubmit, scheduleFilterSubmit };
  for (const form of eligibleGetForms()) enhanceForm(form);
  enhancePlanFilters();
})();
