'use strict';

(() => {
    if (typeof document === 'undefined') return;

    const tables = Array.from(document.querySelectorAll('[data-plan-table]'));
    if (!tables.length) return;

    const rows = tables.flatMap(table => Array.from(table.querySelectorAll('tbody [data-plan-row]')).map(row => ({ row, table, tbody: table.querySelector('tbody') }))).map((item, index) => ({ ...item, index }));
    const search = document.querySelector('[data-plan-search]');
    const status = document.querySelector('[data-plan-status]');
    const delivery = document.querySelector('[data-plan-delivery]');
    const price = document.querySelector('[data-plan-price]');
    const billing = document.querySelector('[data-plan-billing]');
    const server = document.querySelector('[data-plan-server]');
    const reset = document.querySelector('[data-plan-reset]');
    const resultCount = document.querySelector('[data-plan-result-count]');
    const filteredEmpty = document.querySelector('[data-plan-filtered-empty]');
    const sections = Array.from(document.querySelectorAll('[data-plan-table-section]'));
    const sortButtons = Array.from(document.querySelectorAll('[data-plan-sort]'));
    let sortKey = null;
    let sortDirection = 'asc';

    function normalized(value) {
        return String(value || '').trim().toLowerCase();
    }

    function numericSortKey(key) {
        return ['status', 'price', 'duration', 'downloads', 'streams', 'subscribers'].includes(key);
    }

    function compareItems(a, b) {
        if (!sortKey) return a.index - b.index;
        const left = a.row.dataset[`sort${sortKey.charAt(0).toUpperCase()}${sortKey.slice(1)}`] ?? '';
        const right = b.row.dataset[`sort${sortKey.charAt(0).toUpperCase()}${sortKey.slice(1)}`] ?? '';
        let comparison;
        if (numericSortKey(sortKey)) comparison = Number(left || 0) - Number(right || 0);
        else comparison = normalized(left).localeCompare(normalized(right), undefined, { numeric: true, sensitivity: 'base' });
        if (comparison === 0) comparison = a.index - b.index;
        return sortDirection === 'asc' ? comparison : -comparison;
    }

    function matches(item) {
        const row = item.row;
        const needle = normalized(search?.value);
        if (needle && !normalized(row.dataset.search).includes(needle)) return false;
        if (status?.value && row.dataset.status !== status.value) return false;
        if (delivery?.value && row.dataset.delivery !== delivery.value) return false;
        if (price?.value && row.dataset.priceType !== price.value) return false;
        if (billing?.value && row.dataset.billing !== billing.value) return false;
        if (server?.value && row.dataset.serverClass !== server.value) return false;
        return true;
    }

    function render() {
        const ordered = rows.slice().sort(compareItems);
        let visible = 0;
        for (const item of ordered) {
            const show = matches(item);
            item.row.hidden = !show;
            if (show) visible += 1;
            item.tbody.appendChild(item.row);
        }
        for (const section of sections) {
            const sectionRows = Array.from(section.querySelectorAll('[data-plan-row]'));
            const shown = sectionRows.filter(row => !row.hidden).length;
            const wrap = section.querySelector('[data-plan-table-wrap]');
            const empty = section.querySelector('.emptyAction');
            const count = section.querySelector('[data-plan-section-count]');
            if (count) count.textContent = `${shown} plan${shown === 1 ? '' : 's'}`;
            if (wrap) wrap.hidden = shown === 0;
            if (empty) empty.hidden = sectionRows.length > 0 && shown > 0;
            section.hidden = sectionRows.length > 0 && shown === 0;
        }
        if (resultCount) resultCount.textContent = `${visible} of ${rows.length} plans`;
        if (filteredEmpty) filteredEmpty.classList.toggle('visible', visible === 0);
    }

    function updateSortIndicators(activeButton) {
        for (const button of sortButtons) {
            if (button === activeButton) button.dataset.direction = sortDirection;
            else delete button.dataset.direction;
        }
    }

    for (const control of [search, status, delivery, price, billing, server]) {
        control?.addEventListener(control === search ? 'input' : 'change', render);
    }

    reset?.addEventListener('click', () => {
        if (search) search.value = '';
        if (status) status.value = '';
        if (delivery) delivery.value = '';
        if (price) price.value = '';
        if (billing) billing.value = '';
        if (server) server.value = '';
        sortKey = null;
        sortDirection = 'asc';
        updateSortIndicators(null);
        render();
        search?.focus();
    });

    for (const button of sortButtons) {
        button.addEventListener('click', () => {
            const key = button.dataset.planSort;
            if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            else {
                sortKey = key;
                sortDirection = ['price', 'duration', 'downloads', 'streams', 'subscribers', 'status'].includes(key) ? 'desc' : 'asc';
            }
            updateSortIndicators(button);
            render();
        });
    }

    function openRow(row) {
        const href = row?.dataset.href;
        if (href) window.location.assign(href);
    }

    for (const item of rows) {
        item.row.addEventListener('click', event => {
            if (event.target.closest('a,button,input,select,label')) return;
            openRow(item.row);
        });
        item.row.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target.closest('a,button,input,select,label')) return;
            event.preventDefault();
            openRow(item.row);
        });
    }

    render();
})();
