'use strict';

(function () {
    async function uploadBrandAsset(button) {
        const kind = button.dataset.brandUpload;
        if (!kind) return;
        const fileInput = document.getElementById(`${kind}File`);
        const status = document.getElementById(`${kind}Status`);
        const file = fileInput?.files?.[0];
        if (!file) {
            if (status) status.textContent = 'Choose a file first.';
            return;
        }
        const csrfToken = button.dataset.csrfToken || '';
        button.disabled = true;
        if (status) status.textContent = 'Uploading…';
        try {
            const response = await fetch(`/admin/settings/branding/${encodeURIComponent(kind)}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-CSRF-Token': csrfToken
                },
                body: file
            });
            const result = await response.json().catch(() => ({ ok: false, error: 'Unexpected server response.' }));
            if (!response.ok || !result.ok) throw new Error(result.error || 'Upload failed.');
            window.location.reload();
        } catch (error) {
            if (status) status.textContent = error.message || 'Upload failed.';
        } finally {
            button.disabled = false;
        }
    }

    document.addEventListener('click', event => {
        const upload = event.target.closest?.('[data-brand-upload]');
        if (!upload) return;
        event.preventDefault();
        uploadBrandAsset(upload);
    });
})();
