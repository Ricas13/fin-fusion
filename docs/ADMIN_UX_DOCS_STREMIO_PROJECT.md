# CAPTaINFiN Admin UX, Documentation & Stremio Foundation

This document tracks the implementation scope for draft PR #70.

## Production regression

The reseller settings/management `column reference "active" is ambiguous` regression was split into hotfix PR #71 and merged independently so production did not have to wait for this larger project.

## Admin UX

The shared admin shell now provides the visual hierarchy rather than requiring page-by-page redesign work:

- wider 248px desktop sidebar
- explicit section labels with all relevant child pages visible
- stable active state and top breadcrumb
- larger page headings and descriptive subtitles
- larger inputs, buttons, tables and form labels
- rounded cards with stronger spacing and separation
- responsive mobile navigation
- dark critical first-paint CSS to reduce unstyled/bright transitions

A shared `SETTING_HELP` registry decorates common settings with plain-language helper text after inline-script sanitization. Page-specific helper copy can still override or supplement this.

## GitBook

`.gitbook.yaml` points GitBook at `docs/guide/` and `SUMMARY.md` defines role-based navigation. The guide now contains customer, reseller, administrator, security, settings, plans/commerce, servers/libraries, subscription and Stremio roadmap content.

The public guide intentionally excludes infrastructure secrets and internal operational runbooks.

## Stremio foundation

Migration `066_stremio_service_foundation.sql` adds:

- `plans.service_type`: `jellyfin`, `stremio`, `bundle`
- immutable `subscriptions.service_type_snapshot`
- explicit `jellyfin_servers.stremio_enabled` opt-in
- `stremio_entitlements` control-plane table with stream limit, server/account assignment and hash-only install credential storage

Existing plans default to `jellyfin`; existing servers default to not Stremio-eligible.

`src/stremio/foundation.js` provides:

- service-type helpers
- high-entropy install credential generation
- SHA-256 hash-only credential storage support
- `.strm`/release filename metadata parsing
- Torrentio-style display label preparation with 2160p/4K, 1080p, 720p and optional source/codec/HDR/audio/group tokens
- no invented metadata when a filename does not contain a reliable signal

The administrator Stremio settings page is preparation-only. It exposes server eligibility, plan delivery state and entitlement/security readiness, but explicitly does not enable or sell a production addon.

## Runtime boundary

The actual Stremio addon runtime remains a separate project. It will need to implement and test:

- Stremio manifest and stream resource endpoints
- user-specific addon installation flow
- Jellyfin item lookup by external metadata ID
- direct Jellyfin playback authorization
- simultaneous-stream admission behavior
- client/platform compatibility
- optional Jellyfin playback progress reporting

No production runtime should be advertised until that work is complete.

## Merge policy

Keep PR #70 draft until the exact final head passes the full repository workflow matrix and the complete diff receives security, migration, route-ownership and UX review.
