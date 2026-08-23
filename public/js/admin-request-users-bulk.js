'use strict';

(() => {
  const all = document.querySelector('[data-request-user-select-all]');
  const boxes = [...document.querySelectorAll('[data-request-user-select]')];
  const count = document.querySelector('[data-request-selected-count]');
  const buttons = [...document.querySelectorAll('[data-requires-request-selection]')];
  if (!boxes.length) return;

  function refresh() {
    const selected = boxes.filter(box => box.checked).length;
    if (count) count.textContent = String(selected);
    if (all) {
      all.checked = selected === boxes.length;
      all.indeterminate = selected > 0 && selected < boxes.length;
    }
    for (const button of buttons) {
      // Preserve integration-level disablement while still preventing an empty
      // bulk submission. The sync button is server-rendered disabled when the
      // request service is not configured.
      if (button.dataset.integrationDisabled === '1') button.disabled = true;
      else button.disabled = selected === 0;
    }
  }

  if (all) all.addEventListener('change', () => {
    for (const box of boxes) box.checked = all.checked;
    refresh();
  });
  for (const box of boxes) box.addEventListener('change', refresh);
  refresh();
})();
