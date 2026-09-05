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

  function compactPortalCard() {
    return [...document.querySelectorAll('.opCard')].find(card =>
      card.querySelector('.opCardHead h2')?.textContent?.trim() === 'Customer / Portal'
    ) || null;
  }

  function registrationCard() {
    return [...document.querySelectorAll('.profileCard')].find(card =>
      card.querySelector('.profileCardHead h2')?.textContent?.trim() === 'Registration'
    ) || null;
  }

  function valueFor(card, label) {
    for (const row of card?.querySelectorAll('.opState') || []) {
      if (row.querySelector(':scope > span:first-child')?.textContent?.trim() === label) {
        return row.querySelector(':scope > strong')?.textContent?.trim() || '';
      }
    }
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

  function hidden(name, value) {
    const input = el('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value == null ? '' : String(value);
    return input;
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
      setStatus(status, 'Invite URL copied.', 'good');
    } catch (_) {
      setStatus(status, 'Copy failed. Select the URL and copy it manually.', 'bad');
    }
  }

  function parseClaimResponse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const input = doc.querySelector('input[aria-label="New customer claim link"]');
    if (input?.value) return { url: input.value };
    const error = doc.querySelector('.notice.error')?.textContent?.trim();
    return { error: error || 'Portal invite URL could not be created.' };
  }

  async function submitClaim(form, submit, result, resultInput, copyButton, status) {
    submit.disabled = true;
    result.hidden = false;
    resultInput.parentElement.hidden = true;
    setStatus(status, 'Creating invite URL…');

    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form).entries()) body.append(name, String(value));

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
      resultInput.parentElement.hidden = false;
      submit.textContent = 'Rotate invite URL';
      setStatus(status, 'Invite URL created. Copy it now — creating another one replaces the previous unused URL.', 'good');
    } catch (error) {
      setStatus(status, error.message || 'Portal invite URL could not be created.', 'bad');
    } finally {
      submit.disabled = false;
    }
  }

  function initCompact(id, csrf) {
    const card = compactPortalCard();
    if (!card) return false;
    if (card.dataset.claimInviteReady === '1') return true;

    // Current Customer 360 renders customers without a CAPTAiNFiN identity as
    // "Not enrolled". The create endpoint still re-checks customers.user_id,
    // so a stale page cannot create an invite after somebody has enrolled them.
    if (valueFor(card, 'Username') !== 'Not enrolled') return true;

    const actions = card.querySelector('.opActions');
    const body = card.querySelector('.opCardBody');
    if (!actions || !body) return true;
    card.dataset.claimInviteReady = '1';

    const form = el('form', 'plainForm customerClaimInviteQuickForm');
    form.method = 'post';
    form.action = `/admin/customer-claims/${encodeURIComponent(id)}/create`;
    form.dataset.nativeSubmit = 'true';
    form.append(hidden('_csrf', csrf), hidden('ttlHours', '168'));
    const currentEmail = valueFor(card, 'Email');
    form.append(hidden('emailLock', currentEmail && currentEmail !== '—' ? currentEmail : ''));

    const submit = el('button', 'button secondary sm', 'Create invite URL');
    submit.type = 'submit';
    form.append(submit);
    actions.append(form);

    const result = el('div', 'opInlineForm customerClaimInviteQuickResult');
    result.hidden = true;
    const resultRow = el('div', 'opInlinePair');
    const resultInput = el('input', 'input');
    resultInput.type = 'text';
    resultInput.readOnly = true;
    resultInput.setAttribute('aria-label', 'New customer invite URL');
    const copyButton = el('button', 'button secondary sm', 'Copy URL');
    copyButton.type = 'button';
    resultRow.append(resultInput, copyButton);
    const status = el('small', 'customerClaimInviteStatus');
    result.append(resultRow, status);
    body.append(result);

    copyButton.addEventListener('click', () => copy(resultInput.value, copyButton, status));
    form.addEventListener('submit', event => {
      event.preventDefault();
      submitClaim(form, submit, result, resultInput, copyButton, status);
    });
    return true;
  }

  function initLegacy(id, csrf) {
    const card = registrationCard();
    if (!card || card.dataset.claimInviteReady === '1') return;

    // Imported customers are canonically unclaimed while customers.user_id is
    // NULL. The legacy server renderer exposes that state as no Portal username.
    if (valueFor(card, 'Portal username') !== '—') return;
    card.dataset.claimInviteReady = '1';

    const wrap = el('div', 'customerClaimInvite');
    const head = el('div', 'customerClaimInviteHead');
    head.append(el('strong', '', 'Portal account not claimed'), el('span', '', 'Imported customer'));

    const form = el('form', 'customerClaimInviteForm');
    form.method = 'post';
    form.action = `/admin/customer-claims/${encodeURIComponent(id)}/create`;
    form.dataset.nativeSubmit = 'true';
    form.append(hidden('_csrf', csrf));

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
    const resultRow = el('div');
    const resultInput = el('input', 'input');
    resultInput.type = 'text';
    resultInput.readOnly = true;
    resultInput.setAttribute('aria-label', 'New customer claim link');
    const copyButton = el('button', 'button secondary', 'Copy link');
    copyButton.type = 'button';
    resultRow.append(resultInput, copyButton);
    result.append(resultRow);
    const status = el('div', 'customerClaimInviteStatus');

    copyButton.addEventListener('click', () => copy(resultInput.value, copyButton, status));
    form.addEventListener('submit', event => {
      event.preventDefault();
      submitClaim(form, submit, result, resultInput, copyButton, status);
    });

    wrap.append(head, form, help, result, status);
    card.querySelector('.profileCardBody')?.append(wrap);
  }

  function init() {
    const id = customerId();
    if (!id || !overviewPage()) return;
    const csrf = document.querySelector('input[name="_csrf"]')?.value;
    if (!csrf) return;
    if (initCompact(id, csrf)) return;
    initLegacy(id, csrf);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
