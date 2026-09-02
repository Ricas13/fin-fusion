'use strict';

(function () {
    function clearFeedback(form) {
        form.querySelectorAll('[data-form-error]').forEach(node => node.remove());
        form.querySelectorAll('[aria-invalid="true"]').forEach(node => {
            node.removeAttribute('aria-invalid');
            node.classList.remove('inputError');
        });
    }

    function fieldControl(form, field) {
        if (!field) return null;
        const escaped = window.CSS?.escape ? CSS.escape(field) : field.replace(/[^A-Za-z0-9_-]/g, '\\$&');
        return form.querySelector(`[name="${escaped}"]`);
    }

    function showFeedback(form, message, field) {
        clearFeedback(form);
        const control = fieldControl(form, field);
        const error = document.createElement('div');
        error.dataset.formError = 'true';
        error.className = control ? 'fieldErrorMessage' : 'formSubmitError';
        error.textContent = message || 'This form could not be saved. Please check the highlighted field.';

        if (control) {
            control.setAttribute('aria-invalid', 'true');
            control.classList.add('inputError');
            const group = control.closest('.formGroup') || control.parentElement;
            group?.appendChild(error);
            control.focus({ preventScroll: true });
            control.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            form.prepend(error);
            error.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function sameOrigin(url) {
        try { return new URL(url, window.location.href).origin === window.location.origin; }
        catch (_) { return false; }
    }

    function explicitSubmitterAttribute(submitter, name) {
        if (!submitter || !submitter.hasAttribute?.(name)) return '';
        return submitter.getAttribute(name) || '';
    }

    // Never read form.action/form.method/form.target/form.enctype directly here.
    // HTML forms expose named controls as properties, so fields such as
    // <input name="action" value="revoke"> can shadow those DOM properties and
    // turn a valid admin mutation into a request to the wrong URL. Attribute
    // reads are deterministic regardless of control names.
    function formAttribute(form, name, fallback = '') {
        if (!form?.getAttribute) return fallback;
        const value = form.getAttribute(name);
        return value == null || value === '' ? fallback : value;
    }

    function actionUrl(form, submitter = null) {
        const override = explicitSubmitterAttribute(submitter, 'formaction');
        const raw = override || formAttribute(form, 'action', window.location.href);
        return new URL(raw, window.location.href).href;
    }

    function actionMethod(form, submitter = null) {
        const override = explicitSubmitterAttribute(submitter, 'formmethod');
        return String(override || formAttribute(form, 'method', 'POST')).toUpperCase();
    }

    function actionPath(form) {
        try { return new URL(formAttribute(form, 'action', window.location.href), window.location.href).pathname; }
        catch (_) { return ''; }
    }

    function shouldEnhance(form) {
        if (String(formAttribute(form, 'method', 'get')).toLowerCase() !== 'post') return false;
        if (form.dataset.nativeSubmit === 'true') return false;
        const target = formAttribute(form, 'target', '');
        if (target && target !== '_self') return false;
        if (String(formAttribute(form, 'enctype', '')).toLowerCase() === 'multipart/form-data') return false;
        if (form.querySelector('input[type="file"]')) return false;
        const path = actionPath(form);
        // Customer 360 mutations follow normal server-side POST/redirect/GET
        // semantics. Keep them native so a generic AJAX enhancement can never
        // swallow redirects, one-time results, or mutation feedback.
        if (/^\/admin\/users\/[0-9a-f-]{36}(?:\/|$)/i.test(path)) return false;
        // Credential forms intentionally use native submission so browser
        // formaction and CSRF behavior stay fully conventional.
        if (path === '/admin/notifications/preferences/delivery') return false;
        // Customer creation returns a one-time activation link in the POST HTML
        // response. Fetching it in the background and reloading the GET form would
        // discard the only operator-visible copy of that result.
        if (path === '/admin/users/new') return false;
        return sameOrigin(actionUrl(form));
    }

    function appendBulkSelections(form, data) {
        if (formAttribute(form, 'id', '') !== 'bulkForm') return;
        const table = document.getElementById('customersTable');
        if (!table) return;
        table.querySelectorAll('.rowCheck:checked').forEach(control => data.append('customerId', control.value));
    }

    function urlencodedBody(form, submitter) {
        const params = new URLSearchParams();
        const data = new FormData(form);
        appendBulkSelections(form, data);
        if (submitter?.name && !data.has(submitter.name)) data.append(submitter.name, submitter.value || '');
        for (const [key, value] of data.entries()) {
            if (typeof File !== 'undefined' && value instanceof File) continue;
            params.append(key, String(value));
        }
        return params;
    }

    async function downloadResponse(response) {
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
        const filename = match ? decodeURIComponent(match[1].replace(/\"/g, '').trim()) : 'download';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function compactMessage(value, max = 600) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
    }

    async function responseMessage(response) {
        try {
            const text = await response.text();
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (contentType.includes('text/html') || /^\s*<!doctype|^\s*<html/i.test(text)) {
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const errorNode = doc.querySelector('.notice.error,[data-form-error],.formSubmitError,.fieldErrorMessage,[role="alert"].error');
                const specific = compactMessage(errorNode?.textContent);
                if (specific) return specific;
                const title = compactMessage(doc.querySelector('h1')?.textContent, 180);
                if (title && /not found|forbidden|invalid|error|failed/i.test(title)) return title;
            }
            const plain = compactMessage(text.replace(/<[^>]+>/g, ' '));
            if (plain && plain.length < 600) return plain;
        } catch (_) {}
        return `Request failed (${response.status}).`;
    }

    async function renderHtmlResponse(response) {
        const text = await response.text();
        document.open();
        document.write(text);
        document.close();
    }

    async function submitEnhanced(event) {
        if (event.defaultPrevented) return;
        const form = event.currentTarget;
        if (!shouldEnhance(form)) return;
        if (!form.reportValidity()) return;
        event.preventDefault();
        clearFeedback(form);
        const submitter = event.submitter || form.querySelector('[type="submit"],button:not([type])');
        const originalDisabled = submitter?.disabled;
        if (submitter) submitter.disabled = true;
        try {
            const data = urlencodedBody(form, submitter);
            const target = actionUrl(form, submitter);
            const csrfToken = form.querySelector('input[name="_csrf"]')?.value || '';
            const response = await fetch(target, {
                method: actionMethod(form, submitter),
                body: data.toString(),
                credentials: 'same-origin',
                redirect: 'follow',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
                    'X-CAPTAiNFiN-AJAX-FORM': '1',
                    'Accept': 'text/html,application/xhtml+xml,application/json'
                }
            });
            const finalUrl = new URL(response.url || target, window.location.href);
            const error = finalUrl.searchParams.get('error');
            const field = finalUrl.searchParams.get('field');
            if (error) { showFeedback(form, error, field); return; }
            const disposition = response.headers.get('content-disposition') || '';
            if (/attachment/i.test(disposition)) { await downloadResponse(response); return; }
            if (!response.ok) { showFeedback(form, await responseMessage(response), null); return; }
            if (response.redirected) { window.location.assign(finalUrl.href); return; }
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (contentType.includes('text/html')) { await renderHtmlResponse(response); return; }
            window.location.reload();
        } catch (_) {
            showFeedback(form, 'The request could not be completed. Check your connection and try again.', null);
        } finally {
            if (submitter) submitter.disabled = Boolean(originalDisabled);
        }
    }

    function confirmSubmit(event) {
        if (event.defaultPrevented) return;
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        const message = form?.dataset?.confirm;
        if (message && !window.confirm(message)) event.preventDefault();
    }

    async function copyLink(button) {
        const value = button.getAttribute('data-copy-link');
        if (!value) return;
        const old = button.textContent;
        try {
            await navigator.clipboard.writeText(value);
            button.textContent = 'Copied';
            button.classList.add('copyDone');
            window.setTimeout(() => { button.textContent = old; button.classList.remove('copyDone'); }, 1400);
        } catch (_) { window.prompt('Copy link', value); }
    }

    async function uploadBrandAsset(button) {
        const kind = button.dataset.brandUpload;
        if (!kind) return;
        const fileInput = document.getElementById(`${kind}File`);
        const status = document.getElementById(`${kind}Status`);
        const file = fileInput?.files?.[0];
        if (!file) { if (status) status.textContent = 'Choose a file first.'; return; }
        const csrfToken = button.dataset.csrfToken || '';
        button.disabled = true;
        if (status) status.textContent = 'Uploading…';
        try {
            const response = await fetch(`/admin/settings/branding/${encodeURIComponent(kind)}`, {
                method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': file.type || 'application/octet-stream','X-CSRF-Token': csrfToken}, body: file
            });
            const result = await response.json().catch(() => ({ ok: false, error: 'Unexpected server response.' }));
            if (!response.ok || !result.ok) throw new Error(result.error || 'Upload failed.');
            window.location.reload();
        } catch (error) { if (status) status.textContent = error.message || 'Upload failed.'; }
        finally { button.disabled = false; }
    }

    document.addEventListener('submit', confirmSubmit, true);
    document.addEventListener('click', event => {
        const copy = event.target.closest?.('[data-copy-link]');
        if (copy) { event.preventDefault(); copyLink(copy); return; }
        const upload = event.target.closest?.('[data-brand-upload]');
        if (upload) { event.preventDefault(); uploadBrandAsset(upload); }
    });
    document.addEventListener('DOMContentLoaded', () => {
        const all = document.getElementById('checkAllPage');
        const table = document.getElementById('customersTable');
        if (all && table) all.addEventListener('change', () => table.querySelectorAll('.rowCheck').forEach(control => { control.checked = all.checked; }));
        document.querySelectorAll('form').forEach(form => {
            if (shouldEnhance(form)) form.addEventListener('submit', submitEnhanced);
            form.addEventListener('input', event => {
                const control = event.target;
                if (!(control instanceof HTMLElement) || control.getAttribute('aria-invalid') !== 'true') return;
                control.removeAttribute('aria-invalid');
                control.classList.remove('inputError');
                control.closest('.formGroup')?.querySelectorAll('[data-form-error]').forEach(node => node.remove());
            });
        });
    });
})();
