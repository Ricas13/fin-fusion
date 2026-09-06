'use strict';

(() => {
  const match = location.pathname.match(/^\/admin\/users\/([0-9a-f-]{36})\/?$/i);
  if (!match) return;
  const customerId = match[1];
  const forms = Array.from(document.querySelectorAll('form[action="/admin/customers/bulk/preview"]'));
  const form = forms.find(candidate => candidate.querySelector('input[name="action"][value="end_jellyfin_plan"]'));
  if (!form) return;
  const button = form.querySelector('button');
  if (!button) return;

  button.textContent = 'Revoke a plan…';
  button.classList.remove('danger');
  button.classList.add('secondary');
  button.type = 'button';
  button.setAttribute('aria-label', 'Choose a specific plan or add-on to revoke');
  button.addEventListener('click', () => {
    location.assign(`/admin/users/${encodeURIComponent(customerId)}/subscriptions/revoke`);
  });
})();
