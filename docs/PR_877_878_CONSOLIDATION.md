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

## Second regression review

All seven GitHub workflows passed on de0b21c9. A deeper deployment review then found two additional issues, now fixed:

- During old/new application overlap, the shared-pool capacity lock must also acquire the previous release's class lock. A PostgreSQL lock-timeout regression verifies that a new acquisition waits for the old-generation lock, while the existing last-place race still admits only one winner.
- An Emby-only eligibility mapping must not disable Jellyfin class fallback in pending/reservation accounting. The reproduced failure counted zero pending customers instead of one. Provider-scoped fallback now agrees with storefront SQL; the regression verifies that a full pool stays full.

Compared the old inactivity module from main at bafc7994 with the new module on identical rows in one PostgreSQL transaction. All 45 comparisons matched after removing ownership metadata: three legacy server policies, five absent/retired/partial/malformed/equivalent plan policies, and enabled/dry-run/paused modes. Eligibility, watched seconds, deadlines, reasons and retry flags matched.

Rechecked Free lifecycle deletion safeguards, lane-adoption history, automatic Free downgrade retries, clean-database registration concurrency (ten winners out of eleven submissions), fleet placement, scheduler definitions, zero-downtime portal deployment, drain/rollback and deployment tooling. The scheduler, scoped deletion worker and deployment scripts have no changes from main.

Customer server selection remains absent: the customer access routes expose credentials and account history, not a server/region selector; registration and checkout do not carry a customer location preference into provisioning. Administrator pool selection is not a customer choice or performance test. Implementing that requires a separate end-to-end choice/reservation/provisioning workflow, including full/unhealthy-server behavior and safe handling of existing accounts.
