'use strict';

(() => {
    function debounce(fn, delay = 250) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    function audienceControls(form) {
        const count = form.querySelector('[data-marketing-audience-count]');
        const status = form.querySelector('[data-marketing-audience-status]');
        const saved = form.querySelector('[data-marketing-saved-segment]');
        const fields = [...form.querySelectorAll('[data-marketing-audience-field]')];
        if (!count || !fields.length) return;
        let sequence = 0;

        async function refresh() {
            const current = ++sequence;
            const params = new URLSearchParams();
            if (saved && saved.value) {
                params.set('segmentId', saved.value);
            } else {
                for (const field of fields) {
                    const value = String(field.value || '').trim();
                    if (value) params.set(field.name, value);
                }
            }
            if (status) status.textContent = 'Checking current audience…';
            try {
                const response = await fetch(`/admin/marketing/audience-preview?${params.toString()}`, {
                    headers: { Accept: 'application/json' },
                    credentials: 'same-origin'
                });
                const data = await response.json().catch(() => null);
                if (current !== sequence) return;
                if (!response.ok || !data?.ok) throw new Error(data?.error || 'Audience preview unavailable');
                count.textContent = String(Number(data.count || 0));
                if (status) status.textContent = saved?.value ? 'Using the saved segment definition' : 'Current consent and customer data';
            } catch (error) {
                if (current !== sequence) return;
                count.textContent = '—';
                if (status) status.textContent = String(error?.message || 'Audience preview unavailable').slice(0, 120);
            }
        }

        const schedule = debounce(refresh);
        for (const field of fields) {
            field.addEventListener('input', schedule);
            field.addEventListener('change', schedule);
        }
        saved?.addEventListener('change', () => {
            const disabled = Boolean(saved.value);
            for (const field of fields) field.disabled = disabled;
            refresh();
        });
        if (saved?.value) for (const field of fields) field.disabled = true;
        refresh();
    }

    document.querySelectorAll('[data-marketing-campaign-form],[data-marketing-segment-form]').forEach(audienceControls);

    const campaignForm = document.querySelector('[data-marketing-campaign-form]');
    const templateSelect = campaignForm?.querySelector('[data-marketing-template-select]');
    const subject = campaignForm?.querySelector('[data-marketing-subject]');
    const body = campaignForm?.querySelector('[data-marketing-body]');
    let templateSequence = 0;
    templateSelect?.addEventListener('change', async () => {
        const id = String(templateSelect.value || '').trim();
        if (!id) return;
        const current = ++templateSequence;
        try {
            const response = await fetch(`/admin/marketing/templates/${encodeURIComponent(id)}`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin'
            });
            const data = await response.json().catch(() => null);
            if (current !== templateSequence || !response.ok || !data?.ok) return;
            if (subject) subject.value = data.template.subject || '';
            if (body) body.value = data.template.bodyText || '';
        } catch (_) {
            // The server will still resolve the selected template on submit.
        }
    });

    document.querySelectorAll('[data-marketing-schedule-form]').forEach(form => {
        form.addEventListener('submit', event => {
            const local = form.querySelector('[data-marketing-local-time]');
            const iso = form.querySelector('[data-marketing-scheduled-iso]');
            if (!local || !iso) return;
            const parsed = local.value ? new Date(local.value) : null;
            if (!parsed || Number.isNaN(parsed.getTime())) {
                event.preventDefault();
                local.setCustomValidity('Choose a valid schedule date and time.');
                local.reportValidity();
                return;
            }
            local.setCustomValidity('');
            iso.value = parsed.toISOString();
        });
        form.querySelector('[data-marketing-local-time]')?.addEventListener('input', event => event.currentTarget.setCustomValidity(''));
    });
})();
