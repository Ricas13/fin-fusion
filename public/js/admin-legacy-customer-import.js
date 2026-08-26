'use strict';

(() => {
  const form = document.querySelector('[data-legacy-import-form]');
  if (!form) return;
  const input = form.querySelector('input[type="file"][data-legacy-files]');
  const payload = form.querySelector('input[name="payload"]');
  const status = form.querySelector('[data-legacy-file-status]');
  const MAX_FILES = 20;
  const MAX_BYTES = 650 * 1024;

  function encodeUtf8Base64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  form.addEventListener('submit', async event => {
    if (!input || !payload || payload.value) return;
    event.preventDefault();
    const files = Array.from(input.files || []);
    if (!files.length) { if (status) status.textContent = 'Choose your legacy Users and Payments CSV files.'; return; }
    if (files.length > MAX_FILES) { if (status) status.textContent = `Choose no more than ${MAX_FILES} CSV files.`; return; }
    if (files.some(file => !/\.csv$/i.test(file.name))) { if (status) status.textContent = 'Only CSV exports are accepted.'; return; }
    const rows = [];
    let bytes = 0;
    try {
      for (const file of files) {
        const text = await file.text();
        bytes += new TextEncoder().encode(text).length;
        if (bytes > MAX_BYTES) throw new Error('The combined CSV files are too large for this migration screen.');
        rows.push({ name: file.name, text });
      }
      const json = JSON.stringify(rows);
      if (new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('The combined CSV files are too large for this migration screen.');
      payload.value = encodeUtf8Base64(json);
      if (status) status.textContent = `Reading ${files.length} CSV file${files.length === 1 ? '' : 's'}…`;
      form.submit();
    } catch (error) {
      if (status) status.textContent = error.message || 'The CSV files could not be read.';
    }
  });
})();
