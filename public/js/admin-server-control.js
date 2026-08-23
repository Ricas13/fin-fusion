'use strict';

(() => {
  function removeRetiredServerWorkflow() {
    document.querySelectorAll('.workflowCardGrid').forEach(nav => {
      if (nav.querySelector('a[href="/admin/servers/operations"],a[href="/admin/libraries"]')) nav.remove();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', removeRetiredServerWorkflow, { once: true });
  else removeRetiredServerWorkflow();
  requestAnimationFrame(removeRetiredServerWorkflow);
})();
