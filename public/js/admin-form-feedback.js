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

    function shouldEnhance(form) {
        if (String(form.method || 'get').toLowerCase() !== 'post') return false;
        if (form.dataset.nativeSubmit === 'true') return false;
        if (form.target && form.target !== '_self') return false;
        return sameOrigin(form.action || window.location.href);
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

    async function submitEnhanced(event) {
        if (event.defaultPrevented) return;
        const form = event.currentTarget;
        if (!shouldEnhance(form)) return;
        if (!form.reportValidity()) return;

        event.preventDefault();
        clearFeedback(form);

        const submitter = event.submitter || form.querySelector('[type="submit"]');
        const originalDisabled = submitter?.disabled;
        if (submitter) submitter.disabled = true;

        try {
            const data = new FormData(form);
            if (submitter?.name && !data.has(submitter.name)) data.append(submitter.name, submitter.value || '');
            const response = await fetch(form.action || window.location.href, {
                method: 'POST',
                body: data,
                credentials: 'same-origin',
                redirect: 'follow',
                headers: {
                    'X-CAPTAINFIN-AJAX-FORM': '1',
                    'Accept': 'text/html,application/xhtml+xml,application/json'
                }
            });

            const finalUrl = new URL(response.url || form.action || window.location.href, window.location.href);
            const error = finalUrl.searchParams.get('error');
            const field = finalUrl.searchParams.get('field');
            if (error) {
                showFeedback(form, error, field);
                return;
            }

            const disposition = response.headers.get('content-disposition') || '';
            if (/attachment/i.test(disposition)) {
                await downloadResponse(response);
                return;
            }

            if (!response.ok) {
                let message = `Request failed (${response.status}).`;
                const type = response.headers.get('content-type') || '';
                if (type.includes('text/plain')) {
                    const text = (await response.text()).trim();
                    if (text && text.length < 300) message = text;
                }
                showFeedback(form, message, null);
                return;
            }

            if (response.redirected || finalUrl.href !== window.location.href) {
                window.location.assign(finalUrl.href);
                return;
            }
            window.location.reload();
        } catch (_) {
            showFeedback(form, 'The request could not be completed. Check your connection and try again.', null);
        } finally {
            if (submitter) submitter.disabled = Boolean(originalDisabled);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
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
