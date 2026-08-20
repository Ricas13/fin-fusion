# Admin configuration pattern

CAPTAiNFiN uses one configuration language across the administration portal.

## The page shape

A page whose primary job is to configure a capability should normally read in this order:

1. **Summary / state** — is the capability healthy, enabled and configured?
2. **Required values or credentials** — only the values needed to make it work.
3. **Boolean choices** — compact shared toggle grids or switch matrices.
4. **Actions** — save/test/rebuild actions beside the configuration they affect.
5. **Recent activity** — operational history or affected customers/items where useful.

Do not create tabs simply to separate small groups of settings. Prefer compact rows and progressive disclosure on one page.

## Boolean settings

Boolean choices use the shared setting controls. Do not invent a page-specific checkbox/toggle style.

- Normal option labels remain readable; density must not come from shrinking text.
- Use a multi-column toggle grid for independent choices such as playback permissions, libraries or protection options.
- Use the smaller switch form for dense row/column matrices such as notification event/channel routing.
- Avoid repeating the same state as a heading, description, pill and ON/OFF label. The switch is the state.
- Keep short help text only when it changes the operator's decision.

Legacy `toggleRow`, `checkRow`, `inlineToggle` and `toggleGrid` markup is progressively upgraded by the shared admin setting layer while older pages are migrated. New server-rendered work should prefer `src/platform/admin-setting-controls.js`.

## Credentials

Configured secrets are state first, input second:

**API key · Configured · Edit**

Do not leave an empty password/API-key field permanently open just to represent a credential that is already stored. Expand the input only when the operator chooses to replace or clear it. Never render the stored secret back to the browser.

## Non-boolean settings

Do not force everything into a toggle. Prices, limits, URLs, priorities, durations and other scalar values should remain the appropriate text/number/select control. Destructive actions remain explicit buttons with the required safeguards.

## Operational pages

Configuration should not bury daily operational information. For pages that combine setup and operations, collapse rarely-used setup behind a status/configure row and keep current activity, errors, customers or events visible.

Examples:

- Payments: provider status/configuration first-class rows; payment operations and recent events remain visible.
- Request service: connection settings are configuration; managed customer sync state is operations.
- Stremio: source summary, compact managed/external rows, expandable library/config controls, then managed-account activity.

## Shared implementation

The canonical assets are:

- `public/css/admin-setting-controls.css` — toggle grids, switches, configured-secret and notification disclosures.
- `public/css/admin-provider-controls.css` — compact provider/configuration disclosure rows.
- `public/js/admin-setting-controls.js` — compatibility/progressive enhancement for existing admin markup.
- `src/platform/admin-setting-controls.js` — reusable server-rendered controls for new code.
- `scripts/admin-settings-coherence-smoke.js` — regression contract preventing UI drift.

When adding a new preference page, reuse these primitives before adding new CSS or a new checkbox layout.
