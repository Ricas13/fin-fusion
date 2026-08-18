'use strict';

(function () {
    function init() {
        const form = document.querySelector('[data-plan-create-form]');
        if (!form) return;

        const frequency = form.querySelector('[data-plan-frequency]');
        const duration = form.querySelector('[data-plan-duration]');
        const durationHelp = form.querySelector('[data-duration-help]');
        const service = form.querySelector('[data-plan-service]');
        const jellyfinFields = form.querySelectorAll('[data-jellyfin-field]');

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
                if (durationHelp) durationHelp.textContent = 'Used for manual extensions of this custom plan.';
            }
        }

        service?.addEventListener('change', syncService);
        frequency?.addEventListener('change', syncFrequency);
        syncService();
        syncFrequency();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
