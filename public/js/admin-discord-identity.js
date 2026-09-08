'use strict';

(() => {
    const path = window.location.pathname;
    const profile = /^\/admin\/users\/[0-9a-f-]{36}\/edit-profile$/i.test(path);
    const legacyAccount = /^\/admin\/users\/[0-9a-f-]{36}\/manage\/account$/i.test(path);
    if (!profile && !legacyAccount) return;

    const fields = [
        ['discordUserId', 'Discord user ID'],
        ['discordUsername', 'Discord username']
    ];

    for (const [name, labelText] of fields) {
        const input = document.querySelector(`input[name="${name}"]`);
        if (!input) continue;
        input.readOnly = true;
        input.setAttribute('aria-readonly', 'true');
        input.setAttribute('autocomplete', 'off');
        const group = input.closest('.formGroup');
        const label = group?.querySelector('label');
        if (label && !label.textContent.includes('linked')) label.textContent = `${labelText} (linked)`;
        if (group && !group.querySelector('[data-discord-linked-help]')) {
            const help = document.createElement('div');
            help.className = 'inlineHelp';
            help.dataset.discordLinkedHelp = 'true';
            help.textContent = 'Managed automatically from the customer’s verified Discord connection. Reconnect Discord from the customer portal to change it.';
            input.insertAdjacentElement('afterend', help);
        }
    }
})();
