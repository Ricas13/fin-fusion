# Admin UX, Documentation and Stremio Foundation Project

## Goals

1. Fix current reseller admin route regressions before visual refactoring.
2. Improve admin information hierarchy while preserving CAPTaINFiN branding.
3. Add plain-language helper text beneath settings and important controls.
4. Maintain user-facing documentation in `docs/guide/` for publication through GitBook or another documentation frontend.
5. Add Stremio commercial/service foundations without implementing the streaming addon runtime in this project.

## UI principles

- One concept per card or section.
- Page title plus a short description of the page purpose.
- Clear separation between primary, secondary and destructive actions.
- More whitespace and larger readable controls than the legacy dense admin forms.
- Settings explain what they affect, not merely repeat the field label.
- Risky controls explain consequences before the user changes them.
- Where a setting needs more detail, provide a contextual Learn more link into the user-facing guide.

## Stremio boundary

This project may introduce service type, entitlement, token and server-eligibility foundations. It must not implement the full addon stream runtime or media playback bridge.

The later runtime is expected to be stream-only. Reliable filename-derived labels such as 2160p/1080p/720p are acceptable for `.strm` items; optional codec/audio enrichment should only be displayed when the underlying data is actually known.

Working commercial direction: $4/month per concurrent Stremio stream. Pricing remains configurable rather than hard-coded.
