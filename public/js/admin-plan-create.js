'use strict';

(function () {
    function init() {
        const form = document.querySelector('[data-plan-create-form]');
        if (!form) return;

        const audience = form.querySelector('[data-plan-audience]');
        const resellerFields = form.querySelector('[data-reseller-credit-fields]');
        const resellerInputs = resellerFields ? resellerFields.querySelectorAll('input') : [];
        const frequency = form.querySelector('[data-plan-frequency]');
        const duration = form.querySelector('[data-plan-duration]');
        const durationHelp = form.querySelector('[data-duration-help]');
        const service = form.querySelector('[data-plan-service]');
        const jellyfinFields = form.querySelectorAll('[data-jellyfin-field]');

        function syncAudience() {
            if (!audience || !resellerFields) return;
            const enabled = audience.value === 'reseller' || audience.value === 'both';
            resellerFields.hidden = !enabled;
            resellerInputs.forEach(input => { input.disabled = !enabled; });
        }

        function syncService() {
            const needsJellyfin = !service || service.value === 'jellyfin' || service.value === 'bundle';
            jellyfinFields.forEach(field => {
                field.hidden = !needsJellyfin;
                field.querySelectorAll('input,select,textarea').forEach(input => { input.disabled = !needsJellyfin; });
            });
        }

        function syncFrequency() {
            if (!frequency || !duration) return;
            const option = frequency.options[frequency.selectedIndex];
            const days = option ? option.dataset.days : '';
            if (days) {
                duration.value = days;
                duration.readOnly = true;
                if (durationHelp) durationHelp.textContent = `${days} days for ${option.textContent.trim()}.`;
            } else {
                duration.readOnly = false;
                if (!duration.value || Number(duration.value) < 1) duration.value = '30';
                if (durationHelp) durationHelp.textContent = 'Used for manual/reseller extensions of this custom plan.';
            }
        }

        audience?.addEventListener('change', syncAudience);
        service?.addEventListener('change', syncService);
        frequency?.addEventListener('change', syncFrequency);
        syncAudience();
        syncService();
        syncFrequency();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
