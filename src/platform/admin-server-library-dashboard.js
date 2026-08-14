'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const registry = require('../jellyfin/registry');
const serversAdmin = require('./admin-servers');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

function site() { return process.env.SITE_NAME || 'CAPTaINFiN'; }
function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function notice(value, kind = '') { return value ? `<div class="notice ${kind}">${esc(value)}</div>` : ''; }
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function date(value) {
    if (!value) return 'never';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString();
}
function healthState(status) {
    if (status === 'healthy') return { cls: 'online', label: 'Online' };
    if (status === 'offline') return { cls: 'offline', label: 'Offline' };
    return { cls: 'unknown', label: 'Checking' };
}
function send(res, options) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    return res.send(layout({ siteName: site(), ...options }));
}

// Keep one authoritative query shape for both initial rendering and the
// lightweight status endpoint. It already includes health timestamps plus the
// customer/session counters, so the browser cannot be refreshed with a
// different/null timestamp immediately after the page renders.
async function dashboardServerRows() {
    return serversAdmin.serverList();
}

function serverRow(req, server) {
    const state = healthState(server.health_status);
    const customerValue = server.max_users
        ? `${Number(server.assigned_users || 0).toLocaleString('en-GB')} / ${Number(server.max_users).toLocaleString('en-GB')}`
        : Number(server.assigned_users || 0).toLocaleString('en-GB');
    return `<div class="compactServerRow" data-server-id="${esc(server.id)}">
        <div class="compactServerIdentity">
            <span class="serverStatusDot ${state.cls}" data-server-status-dot title="${esc(state.label)}"></span>
            <div class="compactServerName"><strong>${esc(server.name)}</strong><span>${esc(server.slug)} · ${esc(server.server_class)}</span></div>
        </div>
        <div class="compactServerMetric"><strong data-server-users>${esc(customerValue)}</strong><span>customers</span></div>
        <div class="compactServerMetric"><strong data-server-streams>${esc(Number(server.active_streams || 0).toLocaleString('en-GB'))}</strong><span>active streams</span></div>
        <div class="compactServerCheck"><span data-server-health-text>${esc(state.label)}</span><small>Last check <span data-server-last-check>${esc(date(server.last_health_check))}</span></small></div>
        <div class="compactServerActions">
            <a class="button secondary" href="/admin/servers/${esc(server.id)}/edit">Manage</a>
            <form method="post" action="/admin/servers/${esc(server.id)}/test">${csrfInput(req)}<button class="button secondary" type="submit">Test</button></form>
        </div>
    </div>`;
}

async function serverBody(req) {
    await runtimeSettings.ensureLoaded();
    const rows = await dashboardServerRows();
    const intervalMinutes = Math.max(1, Math.round(runtimeSettings.serverHealthIntervalMs() / 60000));
    return `${notice(req.query.message)}${notice(req.query.error, 'error')}
        <section class="section compactServerSection">
            <div class="sectionHead"><h2>Configured servers</h2><span class="muted">${rows.length} total · health check every ${intervalMinutes} min</span></div>
            ${rows.length ? `<div class="compactServerRows">${rows.map(server => serverRow(req, server)).join('')}</div>` : '<div class="empty">No Jellyfin servers configured.</div>'}
        </section>
        <script src="/js/admin-server-library-dashboard.js" defer></script>`;
}

function libraryCountSpec(collectionType) {
    const type = String(collectionType || '').toLowerCase();
    const specs = {
        movies: { include: 'Movie', label: 'movies' },
        tvshows: { include: 'Series', label: 'series' },
        music: { include: 'MusicAlbum', label: 'albums' },
        books: { include: 'Book', label: 'books' },
        boxsets: { include: 'BoxSet', label: 'collections' },
        musicvideos: { include: 'MusicVideo', label: 'videos' },
        homevideosandphotos: { include: 'Video,Photo', label: 'items' }
    };
    return specs[type] || { include: null, label: 'items' };
}

function libraryTypeLabel(collectionType) {
    const type = String(collectionType || 'mixed').toLowerCase();
    const labels = {
        movies: 'Movies',
        tvshows: 'TV Shows',
        music: 'Music',
        books: 'Books',
        boxsets: 'Collections',
        musicvideos: 'Music Videos',
        homevideosandphotos: 'Home Videos & Photos',
        mixed: 'Mixed'
    };
    return labels[type] || type.replace(/(^|[-_])([a-z])/g, (_match, _separator, character) => ` ${character.toUpperCase()}`).trim();
}

async function mapLimit(items, limit, worker) {
    if (!items.length) return [];
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            output[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
}

async function libraryWithCount(serverId, library) {
    const spec = libraryCountSpec(library?.CollectionType);
    if (!library?.ItemId) return { ...library, itemCount: null, countLabel: spec.label };
    const params = new URLSearchParams({ ParentId: String(library.ItemId), Limit: '1' });
    if (spec.include) {
        params.set('Recursive', 'true');
        params.set('IncludeItemTypes', spec.include);
    } else {
        params.set('Recursive', 'false');
    }
    try {
        const response = await registry.request(serverId, `/Items?${params.toString()}`, { timeoutMs: 8000 });
        const count = Number(response?.TotalRecordCount);
        return { ...library, itemCount: Number.isFinite(count) ? count : null, countLabel: spec.label };
    } catch (_) {
        return { ...library, itemCount: null, countLabel: spec.label };
    }
}

function libraryRow(library) {
    const name = String(library?.Name || 'Unnamed');
    const type = String(library?.CollectionType || 'mixed').toLowerCase();
    const count = library.itemCount == null ? '' : String(Number(library.itemCount));
    return `<tr data-library-row data-name="${esc(name.toLowerCase())}" data-type="${esc(type)}" data-count="${esc(count)}">
        <td><strong>${esc(name)}</strong></td>
        <td>${esc(libraryTypeLabel(type))}</td>
        <td class="libraryCountCell">${library.itemCount == null ? '—' : esc(Number(library.itemCount).toLocaleString('en-GB'))}</td>
    </tr>`;
}

function libraryServer(req, group) {
    const state = group.ok ? { cls: 'online', label: 'Connected' } : { cls: 'offline', label: 'Unavailable' };
    const types = [...new Set(group.libs.map(lib => String(lib?.CollectionType || 'mixed').toLowerCase()))].sort();
    const typeOptions = types.map(type => `<option value="${esc(type)}">${esc(libraryTypeLabel(type))}</option>`).join('');
    return `<details class="libraryServer" data-library-server data-library-server-id="${esc(group.server.id)}">
        <summary>
            <span class="libraryServerSummaryMain"><span class="serverStatusDot ${state.cls}" title="${esc(state.label)}"></span><strong>${esc(group.server.name)}</strong></span>
            <span class="libraryServerSummaryMeta"><span data-library-visible>${group.libs.length} ${group.libs.length === 1 ? 'library' : 'libraries'}</span><span class="libraryChevron" aria-hidden="true"></span></span>
        </summary>
        <div class="libraryServerBody">
            ${group.libs.length ? `<div class="libraryFilters">
                <label><span>Library name</span><input class="input" type="search" placeholder="Filter by name" data-library-name-filter></label>
                <label><span>Type</span><select class="input" data-library-type-filter><option value="">All types</option>${typeOptions}</select></label>
                <label><span>Minimum count</span><input class="input" type="number" min="0" step="1" placeholder="Any" data-library-min-filter></label>
                <label><span>Sort</span><select class="input" data-library-sort>
                    <option value="name-asc">Name A–Z</option>
                    <option value="name-desc">Name Z–A</option>
                    <option value="count-desc">Count high–low</option>
                    <option value="count-asc">Count low–high</option>
                    <option value="type-asc">Type A–Z</option>
                    <option value="type-desc">Type Z–A</option>
                </select></label>
                <button class="button secondary libraryReset" type="button" data-library-reset>Reset</button>
            </div>
            <div class="tableWrap"><table class="dataTable libraryTable" data-library-table>
                <thead><tr>
                    <th><button type="button" class="tableSortButton" data-library-sort-button="name">Library <span aria-hidden="true">↕</span></button></th>
                    <th><button type="button" class="tableSortButton" data-library-sort-button="type">Type <span aria-hidden="true">↕</span></button></th>
                    <th><button type="button" class="tableSortButton" data-library-sort-button="count">Count <span aria-hidden="true">↕</span></button></th>
                </tr></thead>
                <tbody>${group.libs.map(libraryRow).join('')}</tbody>
            </table></div>` : `<div class="empty">${group.ok ? 'No library information returned.' : 'The server could not be reached.'}</div>`}
            <div class="libraryServerFooter">
                <span class="muted">${esc(state.label)}</span>
                <form method="post" action="/admin/libraries/${esc(group.server.id)}/refresh">${csrfInput(req)}<button class="button secondary">Scan library</button></form>
            </div>
        </div>
    </details>`;
}

async function librariesBody(req) {
    const servers = await registry.listServers({ enabledOnly: true });
    const groups = await mapLimit(servers, 3, async server => {
        try {
            const folders = await registry.request(server.id, '/Library/VirtualFolders', { timeoutMs: 8000 });
            const raw = Array.isArray(folders) ? folders : [];
            const libs = await mapLimit(raw, 4, library => libraryWithCount(server.id, library));
            return { server, ok: true, libs };
        } catch (_) {
            return { server, ok: false, libs: [] };
        }
    });
    return `${notice(req.query.message)}${notice(req.query.error, 'error')}
        <div class="libraryServerList">${groups.length ? groups.map(group => libraryServer(req, group)).join('') : '<div class="empty">No enabled Jellyfin servers configured.</div>'}</div>
        <script src="/js/admin-server-library-dashboard.js" defer></script>`;
}

function isoDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function serverStatusJson(_req, res, next) {
    try {
        const rows = await dashboardServerRows();
        return res.json({
            servers: rows.map(server => ({
                id: String(server.id),
                status: server.health_status || 'unknown',
                lastHealthCheck: isoDate(server.last_health_check),
                customers: Number(server.assigned_users || 0),
                maxUsers: server.max_users == null ? null : Number(server.max_users),
                activeStreams: Number(server.active_streams || 0)
            }))
        });
    } catch (error) {
        return next(error);
    }
}

function createAdminServerLibraryDashboardRouter() {
    const router = express.Router();
    router.use('/admin', gate, noStore);
    router.get('/admin/servers/status.json', serverStatusJson);
    router.get('/admin/servers', async (req, res, next) => {
        try {
            return send(res, {
                active: 'servers',
                title: 'Servers',
                subtitle: 'Jellyfin availability, customers, streams and management',
                body: await serverBody(req),
                action: '<a class="button" href="/admin/servers/new">Add server</a>'
            });
        } catch (error) { return next(error); }
    });
    router.get('/admin/libraries', async (req, res, next) => {
        try {
            return send(res, {
                active: 'libraries',
                title: 'Libraries',
                subtitle: 'Filterable library inventory grouped by Jellyfin server',
                body: await librariesBody(req)
            });
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminServerLibraryDashboardRouter, dashboardServerRows, serverStatusJson };
