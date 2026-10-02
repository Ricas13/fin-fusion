# Platform / UI helper inventory

This inventory supports the codebase-simplification roadmap. It distinguishes mechanics that should have one implementation from feature-specific rendering that is clearer when kept local.

## Canonical shared helpers

- HTML escaping and CSRF hidden inputs: `src/platform/html-primitives.js`.
- Reusable admin checkbox form mechanics: `src/platform/admin-checkbox-form.js`.
- Currency/minor-unit display: `src/platform/money-format.js`.

These are architectural boundaries: new general-purpose implementations should use the canonical helper rather than adding another local version.

## Inventory categories

`scripts/ui-helper-inventory.js` scans `src/platform` for local definitions in the roadmap categories:

- HTML escaping
- CSRF hidden inputs
- confirmation parsing
- date/time rendering
- notice/error redirects
- pills/status tones
- common form rows/buttons/cards

The report is deliberately an inventory rather than a blanket failure. Date labels, status tones and compact feature cards are often domain-specific; forcing every occurrence through a generic abstraction would make those modules harder to read.

## Migration rule

Migrate a local helper when it duplicates security-sensitive or mechanically identical behaviour. Keep it local when it expresses feature-specific presentation or business vocabulary. Any new shared primitive must have hostile-input or equivalent contract coverage before callers are migrated.
