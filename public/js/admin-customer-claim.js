'use strict';

(function () {
  function customerId() {
    const match = location.pathname.match(/^\/admin\/users\/([0-9a-f-]{36})$/i);
    return match ? match[1] : null;
  }

  function overviewPage() {
    const tab = new URLSearchParams(location.search).get('tab');
    return !tab || tab === 'overview';
  }

  function registrationCard() {
    return [...document.querySelectorAll('.profileCard')].find(card =>
      card.querySelector('.profileCardHead h2')?.textContent?.trim() === 'Registration'
    ) || null;
  }

  function valueFor(card, label) {
    for (const row of card?.querySelectorAll('.kvRow') || []) {
      if (row.querySelector('.kvLabel')?.textContent?.trim() === label) {
        return row.querySelector('.kvValue')?.textContent?.trim() || '';
      }
    }
    return '';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function option(value, label, selected = false) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    item.selected = selected;
    return item;
  }

  function setStatus(node, text, tone = '') {
    node.className = `customerClaimInviteStatus${tone ? ` ${tone}` : ''}`;
    node.textContent = text;
  }

  async function copy(value, button, status) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = button.parentElement?.querySelector('input');
        input?.select();
        if (!document.execCommand('copy')) throw new Error('Copy was not available.');
      }
      setStatus(status, 'Invite link copied.', 'good');
    } catch (_) {
      setStatus(status, 'Copy failed. Select the link and copy it manually.', 'bad');
    }
  }

  function parseClaimResponse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const input = doc.querySelector('input[aria-label="New customer claim link"]');
    if (input?.value) return { url: input.value };
    const error = doc.querySelector('.notice.error')?.textContent?.trim();
    return { error: error || 'Portal invite link could not be created.' };
  }

  function init() {
    const id = customerId();
    if (!id || !overviewPage()) return;
    const card = registrationCard();
    if (!card || card.dataset.claimInviteReady === '1') return;

    // Imported customers are canonically unclaimed while customers.user_id is
    // NULL. The server renders that state as no Portal username. The claim
    // endpoint independently re-checks user_id, so this UI is never the safety
    // boundary if the page becomes stale between render and submit.
    if (valueFor(card, 'Portal username') !== '—') return;
    const csrf = document.querySelector('input[name="_csrf"]')?.value;
    if (!csrf) return;
    card.dataset.claimInviteReady = '1';

    const wrap = el('div', 'customerClaimInvite');
    const head = el('div', 'customerClaimInviteHead');
    head.append(el('strong', '', 'Portal account not claimed'), el('span', '', 'Imported customer'));

    const form = el('form', 'customerClaimInviteForm');
    form.method = 'post';
    form.action = `/admin/customer-claims/${encodeURIComponent(id)}/create`;

    const ttl = el('select', 'input');
    ttl.name = 'ttlHours';
    ttl.setAttribute('aria-label', 'Invite link expiry');
    ttl.append(option('24', '1 day'), option('72', '3 days'), option('168', '7 days', true), option('336', '14 days'), option('720', '30 days'));

    const email = el('input', 'input');
    email.type = 'email';
    email.name = 'emailLock';
    email.maxLength = 254;
    email.placeholder = 'Email lock (optional)';
    email.setAttribute('aria-label', 'Optional email lock');
    const currentEmail = valueFor(card, 'Email');
    if (currentEmail && currentEmail !== '—') email.value = currentEmail;

    const submit = el('button', 'button', 'Create invite link');
    submit.type = 'submit';
    form.append(ttl, email, submit);

    const help = el('div', 'customerClaimInviteHelp', 'Creates the existing secure claim flow. The customer chooses a CAPTAiNFiN portal username/password; their Jellyfin password is not changed. Creating another link revokes the previous unused link.');
    const result = el('div', 'customerClaimInviteResult');
    result.hidden = true;
    const resultInput = el('input', 'input');
    resultInput.type = 'text';
    resultInput.readOnly = true;
    resultInput.setAttribute('aria-label', 'New customer claim link');
    const copyButton = el('button', 'button secondary', 'Copy link');
    copyButton.type = 'button';
    result.append(resultInput, copyButton);
    const status = el('div', 'customerClaimInviteStatus');

    copyButton.addEventListener('click', () => copy(resultInput.value, copyButton, status));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      setStatus(status, 'Creating invite link…');
      const body = new URLSearchParams({ _csrf: csrf, ttlHours: ttl.value, emailLock: email.value.trim() });
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'follow',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'text/html' },
          body: body.toString()
        });
        if (!response.ok) throw new Error(response.status === 403 ? 'Security token expired. Refresh the page and try again.' : `Invite request failed (${response.status}).`);
        const parsed = parseClaimResponse(await response.text());
        if (!parsed.url) throw new Error(parsed.error);
        resultInput.value = parsed.url;
        result.hidden = false;
        submit.textContent = 'Rotate invite link';
        setStatus(status, 'New invite created. Copy it now — the bearer token is shown only once.', 'good');
      } catch (error) {
        setStatus(status, error.message || 'Portal invite link could not be created.', 'bad');
      } finally {
        submit.disabled = false;
      }
    });

    wrap.append(head, form, help, result, status);
    card.querySelector('.profileCardBody')?.append(wrap);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
