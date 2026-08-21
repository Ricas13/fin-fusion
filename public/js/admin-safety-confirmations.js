'use strict';

(function () {
    document.addEventListener('submit', event => {
        if (event.defaultPrevented) return;
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        if (!form || form.dataset.confirm) return;
        const control = form.querySelector('[data-confirm-when-checked]:checked');
        const message = control?.getAttribute('data-confirm-when-checked') || '';
        if (message && !window.confirm(message)) event.preventDefault();
    }, true);
})();
