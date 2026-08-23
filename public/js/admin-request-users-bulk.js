'use strict';

(() => {
  const all = document.querySelector('[data-request-user-select-all]');
  const boxes = [...document.querySelectorAll('[data-request-user-select]')];
  const count = document.querySelector('[data-request-selected-count]');
  const buttons = [...document.querySelectorAll('[data-requires-request-selection]')];
  const permanentlyDisabled = new WeakSet(buttons.filter(button => button.disabled));
  if (!boxes.length) return;

  function refresh() {
    const selected = boxes.filter(box => box.checked).length;
    if (count) count.textContent = String(selected);
    if (all) {
      all.checked = selected === boxes.length;
      all.indeterminate = selected > 0 && selected < boxes.length;
    }
    for (const button of buttons) button.disabled = permanentlyDisabled.has(button) || selected === 0;
  }

  if (all) all.addEventListener('change', () => {
    for (const box of boxes) box.checked = all.checked;
    refresh();
  });
  for (const box of boxes) box.addEventListener('change', refresh);
  refresh();
})();
