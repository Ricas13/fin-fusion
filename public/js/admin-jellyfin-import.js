'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('selectAllImports');
    const form = document.getElementById('importForm');
    if (button) {
        button.addEventListener('click', () => {
            document.querySelectorAll('.importCheck').forEach(box => { box.checked = true; });
        });
    }
    if (form) {
        form.addEventListener('submit', () => {
            document.querySelectorAll('.importCheck:checked').forEach(box => {
                const hidden = document.createElement('input');
                hidden.type = 'hidden';
                hidden.name = 'selected';
                hidden.value = box.value;
                form.appendChild(hidden);
            });
        });
    }
});
