'use strict';

// Pure, DB/network-free computation of "effective" Jellyfin policy from the
// PLAN -> ADMIN OVERRIDE -> CUSTOMER DESELECTION chain. Kept side-effect free
// on purpose so it can be unit tested without Postgres/Jellyfin and so every
// caller (provisioning, Customer 360, customer self-service, bulk jobs)
// computes entitlement the exact same way -- the backend is always the
// authority; nothing here ever trusts a caller-supplied "effective" value.

const TECHNICAL_FIELDS = [
    'streams',
    'allow_downloads',
    'allow_video_transcoding',
    'allow_audio_transcoding',
    'allow_remuxing',
    'allow_live_tv',
    'allow_live_tv_management',
    'allow_remote_access',
    'allow_subtitle_editing'
];

const DEFAULT_PLAN_VALUES = {
    streams: 1,
    allow_downloads: false,
    allow_video_transcoding: false,
    allow_audio_transcoding: false,
    allow_remuxing: false,
    allow_live_tv: false,
    allow_live_tv_management: false,
    allow_remote_access: false,
    allow_subtitle_editing: true
};

function hasValue(v) {
    return v !== null && v !== undefined;
}

// Returns { field: { plan, override, effective } } for every technical field.
// `override` is null when no override is set for that field (displayed as
// "-" in the UI); `effective` is override ?? plan.
function effectiveTechnicalPolicy(plan, override) {
    const rows = {};
    for (const field of TECHNICAL_FIELDS) {
        const planValue = hasValue(plan?.[field]) ? plan[field] : DEFAULT_PLAN_VALUES[field];
        const overrideValue = hasValue(override?.[field]) ? override[field] : null;
        rows[field] = {
            plan: planValue,
            override: overrideValue,
            effective: overrideValue !== null ? overrideValue : planValue
        };
    }
    return rows;
}

function flattenEffective(rows) {
    const flat = {};
    for (const field of TECHNICAL_FIELDS) flat[field] = rows[field].effective;
    return flat;
}

function normalizedNames(list) {
    return Array.from(new Set(
        (Array.isArray(list) ? list : [])
            .map(value => String(value || '').trim())
            .filter(Boolean)
    ));
}

function nameKey(name) {
    return String(name || '').trim().toLocaleLowerCase('en-GB');
}

function planGrantsLibrary(plan, name) {
    const mode = ['all', 'exclude', 'include'].includes(plan?.library_access_mode)
        ? plan.library_access_mode
        : 'all';
    const configured = new Set(normalizedNames(plan?.library_names).map(nameKey));
    const key = nameKey(name);
    if (mode === 'all') return true;
    if (mode === 'include') return configured.has(key);
    return !configured.has(key); // exclude
}

// overrides: rows shaped like customer_library_overrides ({library_name, granted}).
// catalogNames: every library name known to exist across the relevant servers
// (from live discovery), so admins can see and override libraries the plan
// doesn't currently mention at all.
function libraryEntitlement(plan, overrides, catalogNames) {
    const overrideMap = new Map(
        (Array.isArray(overrides) ? overrides : [])
            .map(o => [nameKey(o.library_name), Boolean(o.granted)])
    );
    const names = normalizedNames(catalogNames);
    return names.map(name => {
        const key = nameKey(name);
        const planGrant = planGrantsLibrary(plan, name);
        const hasOverride = overrideMap.has(key);
        const overrideGrant = hasOverride ? overrideMap.get(key) : null;
        return {
            name,
            plan: planGrant,
            override: overrideGrant,
            effective: hasOverride ? overrideGrant : planGrant
        };
    });
}

// selection: { selected_names } row from customer_library_selection, or null
// if the customer has never recorded a preference (defaults to full
// entitlement). Always intersects with the server-computed entitlement --
// selection can only narrow, a manipulated/stale selection can never widen.
function customerVisibleLibraries(entitlementRows, selection) {
    const entitledNames = entitlementRows.filter(row => row.effective).map(row => row.name);
    if (!selection) return entitledNames;
    const chosen = new Set(normalizedNames(selection.selected_names).map(nameKey));
    return entitledNames.filter(name => chosen.has(nameKey(name)));
}

// Resolves a set of visible library names to one specific server's actual
// folder IDs. Never returns anything for a name that isn't in `serverFolders`
// -- such names are reported in `missing` and simply omitted, so the caller
// can never end up granting access to something that doesn't exist on that
// server (and, since this never falls back to "grant everything", a missing
// name narrows the applied policy rather than broadening it).
function resolveNamesToIds(visibleNames, serverFolders) {
    const byKey = new Map(
        (Array.isArray(serverFolders) ? serverFolders : [])
            .filter(folder => folder && folder.id && folder.name)
            .map(folder => [nameKey(folder.name), folder.id])
    );
    const enabledFolders = [];
    const missing = [];
    for (const name of normalizedNames(visibleNames)) {
        const id = byKey.get(nameKey(name));
        if (id) enabledFolders.push(id); else missing.push(name);
    }
    return { enabledFolders, missing };
}

// Computes which per-library overrides a bulk "Add / Remove / Replace"
// action should write, given the libraries the admin picked and the full
// discovered catalog. This is the entire semantic difference between the
// three modes, kept as one pure function so "Add never becomes Replace" is a
// property of this function's output, not of how callers happen to loop:
//   - add:     grant=true for the picked libraries only; nothing else touched.
//   - remove:  grant=false for the picked libraries only; nothing else touched.
//   - replace: grant=true for picked libraries, grant=false for every OTHER
//              catalog library -- this is the only mode that touches
//              libraries outside the picked set, by design.
function libraryOverridePlan(mode, wantedNames, catalogNames) {
    const wanted = normalizedNames(wantedNames).filter(name =>
        normalizedNames(catalogNames).some(c => nameKey(c) === nameKey(name))
    );
    if (mode === 'add') return wanted.map(name => ({ name, granted: true }));
    if (mode === 'remove') return wanted.map(name => ({ name, granted: false }));
    if (mode === 'replace') {
        const wantedKeys = new Set(wanted.map(nameKey));
        return normalizedNames(catalogNames).map(name => ({ name, granted: wantedKeys.has(nameKey(name)) }));
    }
    return [];
}

module.exports = {
    TECHNICAL_FIELDS,
    effectiveTechnicalPolicy,
    flattenEffective,
    normalizedNames,
    nameKey,
    planGrantsLibrary,
    libraryEntitlement,
    customerVisibleLibraries,
    resolveNamesToIds,
    libraryOverridePlan
};
