'use strict';

(() => {
  const form = document.querySelector('form.compactFilterForm[action="/admin/users"]');
  if (!form) return;

  const field = name => form.querySelector(`[name="${name}"]`);
  const group = name => field(name)?.closest('.formGroup');
  const originalGrid = form.querySelector('.formGrid');
  const originalButtons = form.querySelector('.buttonRow');
  if (!originalGrid) return;

  const style = document.createElement('style');
  style.textContent = `
    .customerFilterToolbar{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
    .customerFilterToolbar .formGroup{margin:0;min-width:126px;flex:0 1 160px}
    .customerFilterToolbar .filterSearch{min-width:240px;flex:1 1 320px}
    .customerFilterToolbar label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .customerFilterToolbar .input{height:38px;min-height:38px}
    .customerFilterActions{display:flex;align-items:center;gap:7px;min-height:38px}
    .customerAdvancedFilters{margin-top:8px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--panel2)}
    .customerAdvancedFilters[hidden]{display:none}
    .customerAdvancedFilters .formGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
    .customerAdvancedFilters .formGroup{margin:0}
    .customerFilterChips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .customerFilterChip{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--border);border-radius:999px;background:var(--panel2);color:var(--text);font-size:12px;cursor:pointer}
    .customerFilterChip:hover{border-color:var(--accent)}
    .customerFilterChip span{color:var(--muted)}
    .customerExpiryPreset{min-width:170px}
    @media(max-width:760px){.customerFilterToolbar{align-items:stretch}.customerFilterToolbar .formGroup,.customerFilterToolbar .filterSearch{min-width:calc(50% - 5px);flex:1 1 calc(50% - 5px)}.customerFilterActions{width:100%}}
    @media(max-width:480px){.customerFilterToolbar .formGroup,.customerFilterToolbar .filterSearch{min-width:100%;flex-basis:100%}}
  `;
  document.head.appendChild(style);

  const toolbar = document.createElement('div');
  toolbar.className = 'customerFilterToolbar';
  toolbar.setAttribute('role', 'search');
  toolbar.setAttribute('aria-label', 'Customer filters');

  const primaryNames = ['q', 'service', 'status', 'plan', 'server'];
  primaryNames.forEach(name => {
    const node = group(name);
    if (!node) return;
    if (name === 'q') node.classList.add('filterSearch');
    toolbar.appendChild(node);
  });

  const actions = document.createElement('div');
  actions.className = 'customerFilterActions';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'button secondary';
  more.textContent = 'More filters';
  more.setAttribute('aria-expanded', 'false');
  const reset = document.createElement('a');
  reset.className = 'button secondary';
  reset.href = '/admin/users';
  reset.textContent = 'Reset';
  actions.append(more, reset);
  toolbar.appendChild(actions);

  const advanced = document.createElement('div');
  advanced.className = 'customerAdvancedFilters';
  advanced.hidden = true;
  const advancedGrid = document.createElement('div');
  advancedGrid.className = 'formGrid';
  advanced.appendChild(advancedGrid);

  const expiryFrom = field('expiryFrom');
  const expiryTo = field('expiryTo');
  if (expiryFrom && expiryTo) {
    const presetGroup = document.createElement('div');
    presetGroup.className = 'formGroup customerExpiryPreset';
    presetGroup.innerHTML = '<label for="customerExpiryPreset">Expiry</label><select class="input" id="customerExpiryPreset"><option value="any">Expiry: Any time</option><option value="today">Expiry: Today</option><option value="7">Expiry: Next 7 days</option><option value="30">Expiry: Next 30 days</option><option value="expired">Expiry: Expired</option><option value="custom">Expiry: Custom range</option></select>';
    advancedGrid.appendChild(presetGroup);
    const preset = presetGroup.querySelector('select');
    if (expiryFrom.value || expiryTo.value) preset.value = 'custom';
    const iso = date => {
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 10);
    };
    preset.addEventListener('change', () => {
      const today = new Date();
      const value = preset.value;
      if (value === 'custom') {
        advanced.hidden = false;
        more.setAttribute('aria-expanded', 'true');
        expiryFrom.focus();
        return;
      }
      expiryFrom.value = '';
      expiryTo.value = '';
      if (value === 'today') expiryFrom.value = expiryTo.value = iso(today);
      if (value === '7' || value === '30') {
        expiryFrom.value = iso(today);
        const end = new Date(today);
        end.setDate(end.getDate() + Number(value));
        expiryTo.value = iso(end);
      }
      if (value === 'expired') expiryTo.value = iso(today);
      form.requestSubmit();
    });
  }

  const advancedNames = ['accountStatus', 'paymentProvider', 'reconciliationStatus', 'hasOverride', 'library', 'expiryFrom', 'expiryTo', 'lastActiveFrom', 'lastActiveTo', 'registeredFrom', 'registeredTo'];
  advancedNames.forEach(name => {
    const node = group(name);
    if (node) advancedGrid.appendChild(node);
  });

  const applyRow = document.createElement('div');
  applyRow.className = 'buttonRow';
  const apply = document.createElement('button');
  apply.className = 'button';
  apply.type = 'submit';
  apply.textContent = 'Apply filters';
  applyRow.appendChild(apply);
  advanced.appendChild(applyRow);

  const chips = document.createElement('div');
  chips.className = 'customerFilterChips';
  chips.setAttribute('aria-label', 'Active filters');

  const labelFor = {
    q: 'Search', service: 'Product', status: 'Status', plan: 'Plan', server: 'Server',
    accountStatus: 'Account', paymentProvider: 'Payment', reconciliationStatus: 'Reconciliation', hasOverride: 'Override', library: 'Library',
    expiryFrom: 'Expiry from', expiryTo: 'Expiry to', lastActiveFrom: 'Active from', lastActiveTo: 'Active to', registeredFrom: 'Registered from', registeredTo: 'Registered to'
  };
  const selectedText = control => control instanceof HTMLSelectElement ? control.options[control.selectedIndex]?.textContent?.trim() : control.value.trim();
  const chipNames = [...primaryNames, ...advancedNames];
  chipNames.forEach(name => {
    const control = field(name);
    if (!control || !control.value) return;
    const text = selectedText(control);
    if (!text || /^any$|^all products$/i.test(text)) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'customerFilterChip';
    chip.innerHTML = `${labelFor[name] || name}: ${text} <span aria-hidden="true">×</span>`;
    chip.setAttribute('aria-label', `Remove ${labelFor[name] || name} filter`);
    chip.addEventListener('click', () => {
      control.value = '';
      if (name === 'expiryFrom' || name === 'expiryTo') {
        const preset = document.getElementById('customerExpiryPreset');
        if (preset) preset.value = 'custom';
      }
      form.requestSubmit();
    });
    chips.appendChild(chip);
  });

  const hasAdvancedValue = advancedNames.some(name => Boolean(field(name)?.value));
  if (hasAdvancedValue) {
    advanced.hidden = false;
    more.setAttribute('aria-expanded', 'true');
  }
  more.addEventListener('click', () => {
    advanced.hidden = !advanced.hidden;
    more.setAttribute('aria-expanded', String(!advanced.hidden));
    more.textContent = advanced.hidden ? 'More filters' : 'Fewer filters';
  });
  if (!advanced.hidden) more.textContent = 'Fewer filters';

  for (const name of ['service', 'status', 'plan', 'server']) {
    const control = field(name);
    if (control) control.addEventListener('change', () => form.requestSubmit());
  }

  originalGrid.replaceWith(toolbar);
  originalButtons?.remove();
  form.appendChild(advanced);
  if (chips.childElementCount) form.appendChild(chips);
})();