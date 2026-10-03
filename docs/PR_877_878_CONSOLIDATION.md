# PR 877 / 878 consolidation review

Both PRs independently implemented plan-owned media capacity and Free inactivity thresholds from the same main branch. They used separate branches and incompatible storage approaches; they were not two halves intended to be merged together. The Git history establishes the overlap, but not why two authoring sessions were started.

The consolidated implementation retains PR 877 as the review target and supersedes PR 878.

## Feature decisions

- Servers retain physical customer capacity, provider, health, admission controls and location.
- Jellyfin/bundle plans can set a lower customer cap. Effective remaining availability is the lower of plan and physical availability.
- Explicit Jellyfin/Emby server selections override class grouping; absent a selection, the legacy class remains the fallback.
- Overlapping plan pools share pending occupancy and an acquisition lock across classes.
- Free plans own initial playback grace, rolling window and minimum watched minutes. Global enable/dry-run and destructive-action safeguards remain unchanged.
- Server location is visible to administrators. Customer-selectable region is excluded from both PRs and remains separate work.

## Compatibility and defects corrected

Use PR 877's existing JSON opt-in marker. PR 878 initially used a migration; its later commits (through 13e58282) replaced that with a runtime zero-to-NULL transition. The consolidated change avoids both automatic rewriting approaches. Historical zero AND positive capacity_limit values remain inert until explicitly saved. Thresholds use nested freeInactivity JSON and only activate as a complete valid policy. Existing per-server thresholds are preserved otherwise. Configure new controls only after the application rollout completes; old application instances do not enforce the new plan caps.

Corrected the inconsistent SQL playback filter in 877, partial-policy/unsafe-cast handling, storefront omission of extension/permanent/manual-presence occupancy, partial availability saves, and incomplete main Jellyfin reconciliation support for selected cross-class servers. Administrator server pins still win. Provider filtering prevents Emby servers appearing in the Jellyfin editor.

## Validation

- All 181 fast checks passed across resumed runs; updated obsolete ownership assertions and one Windows line-ending-sensitive assertion.
- New PostgreSQL regression: legacy zero/positive caps, plan/physical bounds, separate product occupancy, extended/permanent/admin-present episodes, cross-class pools, competing acquisitions for one remaining physical place, complete/partial/malformed policies, 14-day plan vs 7-day server playback, policy preservation and failed-save atomicity.
- Existing database checks passed: Free Server lifecycle (including active-playback and failed-delete safeguards), Free account lane-adoption history, canonical plan creation, fleet-aware placement.
- No migration added. GitHub release/deployment workflows must pass on the final head before merge. No production deployment was performed.

Late PR 878 commits were reviewed before closure. Their uncapped fleet usage compatibility fix is retained; the automatic global transition is replaced by per-plan explicit opt-in.
