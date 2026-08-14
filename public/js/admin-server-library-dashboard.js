'use strict';

(function () {
    function normalise(value) { return String(value || '').trim().toLowerCase(); }
    function numberOrNull(value) {
        if (value === '' || value == null) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function initLibraryServer(root) {
        const serverId = String(root.dataset.libraryServerId || '').trim();
        const storageKey = serverId ? `captainfin.admin.libraries.open.${serverId}` : null;
        if (storageKey) {
            try { root.open = window.localStorage.getItem(storageKey) === '1'; } catch (_) {}
            root.addEventListener('toggle', () => {
                try { window.localStorage.setItem(storageKey, root.open ? '1' : '0'); } catch (_) {}
            });
        }

        const table = root.querySelector('[data-library-table]');
        if (!table) return;
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('[data-library-row]'));
        const nameInput = root.querySelector('[data-library-name-filter]');
        const typeInput = root.querySelector('[data-library-type-filter]');
        const minInput = root.querySelector('[data-library-min-filter]');
        const sortInput = root.querySelector('[data-library-sort]');
        const reset = root.querySelector('[data-library-reset]');
        const visibleLabel = root.querySelector('[data-library-visible]');
        let sortKey = 'name';
        let sortDirection = 'asc';

        function readSort(value) {
            const [key, direction] = String(value || 'name-asc').split('-');
            sortKey = ['name', 'type', 'count'].includes(key) ? key : 'name';
            sortDirection = direction === 'desc' ? 'desc' : 'asc';
        }

        function compareRows(a, b) {
            if (sortKey === 'count') {
                const av = numberOrNull(a.dataset.count);
                const bv = numberOrNull(b.dataset.count);
                if (av == null && bv == null) return a.dataset.name.localeCompare(b.dataset.name);
                if (av == null) return 1;
                if (bv == null) return -1;
                const result = av - bv;
                return sortDirection === 'desc' ? -result : result;
            }
            const av = normalise(a.dataset[sortKey]);
            const bv = normalise(b.dataset[sortKey]);
            const result = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
            return sortDirection === 'desc' ? -result : result;
        }

        function apply() {
            const query = normalise(nameInput?.value);
            const type = normalise(typeInput?.value);
            const minimum = numberOrNull(minInput?.value);
            const sorted = [...rows].sort(compareRows);
            let visible = 0;
            sorted.forEach(row => {
                const count = numberOrNull(row.dataset.count);
                const matchesName = !query || normalise(row.dataset.name).includes(query);
                const matchesType = !type || normalise(row.dataset.type) === type;
                const matchesMinimum = minimum == null || (count != null && count >= minimum);
                row.hidden = !(matchesName && matchesType && matchesMinimum);
                if (!row.hidden) visible += 1;
                tbody.appendChild(row);
            });
            if (visibleLabel) visibleLabel.textContent = `${visible} / ${rows.length} ${rows.length === 1 ? 'library' : 'libraries'}`;
            root.querySelectorAll('[data-library-sort-button]').forEach(button => {
                button.classList.toggle('active', button.dataset.librarySortButton === sortKey);
                button.dataset.direction = button.dataset.librarySortButton === sortKey ? sortDirection : '';
            });
        }

        readSort(sortInput?.value);
        nameInput?.addEventListener('input', apply);
        typeInput?.addEventListener('change', apply);
        minInput?.addEventListener('input', apply);
        sortInput?.addEventListener('change', () => { readSort(sortInput.value); apply(); });
        reset?.addEventListener('click', () => {
            if (nameInput) nameInput.value = '';
            if (typeInput) typeInput.value = '';
            if (minInput) minInput.value = '';
            if (sortInput) sortInput.value = 'name-asc';
            readSort('name-asc');
            apply();
        });
        root.querySelectorAll('[data-library-sort-button]').forEach(button => {
            button.addEventListener('click', () => {
                const key = button.dataset.librarySortButton;
                const nextDirection = sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc';
                sortKey = key;
                sortDirection = nextDirection;
                if (sortInput) sortInput.value = `${key}-${nextDirection}`;
                apply();
            });
        });
        apply();
    }

    function statusState(value) {
        if (value === 'healthy') return { cls: 'online', label: 'Online' };
        if (value === 'offline') return { cls: 'offline', label: 'Offline' };
        return { cls: 'unknown', label: 'Checking' };
    }

    function formatDate(value) {
        if (!value) return 'never';
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString();
    }

    async function refreshServerRows() {
        const roots = new Map(Array.from(document.querySelectorAll('[data-server-id]')).map(root => [String(root.dataset.serverId), root]));
        if (!roots.size) return;
        try {
            const response = await fetch('/admin/servers/status.json', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            if (!response.ok) return;
            const payload = await response.json();
            for (const server of payload.servers || []) {
                const root = roots.get(String(server.id));
                if (!root) continue;
                const state = statusState(server.status);
                const dot = root.querySelector('[data-server-status-dot]');
                if (dot) {
                    dot.classList.remove('online', 'offline', 'unknown');
                    dot.classList.add(state.cls);
                    dot.title = state.label;
                }
                const statusText = root.querySelector('[data-server-health-text]');
                if (statusText) statusText.textContent = state.label;
                const users = root.querySelector('[data-server-users]');
                if (users) users.textContent = server.maxUsers == null
                    ? Number(server.customers || 0).toLocaleString()
                    : `${Number(server.customers || 0).toLocaleString()} / ${Number(server.maxUsers).toLocaleString()}`;
                const streams = root.querySelector('[data-server-streams]');
                if (streams) streams.textContent = Number(server.activeStreams || 0).toLocaleString();
                const lastCheck = root.querySelector('[data-server-last-check]');
                // A polling response must never erase a timestamp already rendered
                // from the database. New/unprobed servers are rendered as "never"
                // initially, so there is no need to write "never" from a null poll.
                if (lastCheck && server.lastHealthCheck) lastCheck.textContent = formatDate(server.lastHealthCheck);
            }
        } catch (_) {
            // Keep the last known server state visible if the lightweight UI refresh fails.
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-library-server]').forEach(initLibraryServer);
        if (document.querySelector('[data-server-id]')) {
            refreshServerRows();
            window.setInterval(refreshServerRows, 30000);
        }
    });
})();
