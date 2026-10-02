# Codebase simplification and canonical ownership roadmap

Baseline: `413b366c0e618d605ee09bb31ae1d05aa9c8b472` (main after PR #828).

This draft PR is the long-lived implementation tracker for the next CAPTAiNFiN / fin-fusion cleanup phase. It is intentionally broader than one ordinary refactor PR so the work can continue safely across multiple sessions without losing the architectural direction.

The purpose is **not** to remove working functionality or weaken safety. The purpose is to reduce the number of places that are allowed to decide the same thing, remove transitional compatibility code once it is genuinely unused, standardise common patterns, and simplify the runtime/test/deployment estate without changing customer-visible behaviour unless explicitly documented.

## Current baseline

At this baseline the repository contains roughly:

- 1,162 tracked files
- 471 files under `src/`
- 218 files under `src/platform/`
- 54 files under `src/payments/`
- 42 files under `src/jellyfin/`
- 29 files under `src/stremio/`
- 25 files under `src/integrations/`
- 20 files under `src/entitlements/`
- 19 files under `src/automation/`
- 14 files under `src/access/`
- 316 files under `scripts/`, around 284 of which are test/check/audit oriented
- 139 SQL migration files

Recent work already moved substantial lifecycle, access-control, individual-action, bulk-action, manual-payment, entitlement-grant, provider and notification ownership out of `src/platform`. This roadmap continues that direction.

## Non-negotiable safety rules

Every implementation batch in this PR must preserve these rules:

- Keep durable provider-operation identity, idempotency and frozen request snapshots.
- Keep advisory locks and serialization around destructive/access-changing operations.
- Keep notification outboxes and uncertain-delivery quarantine.
- Keep immutable commercial snapshots.
- Keep access holds, administrator authority and fail-closed behaviour.
- Keep encrypted pre-deploy backups and migration-aware rollback boundaries.
- Keep exact subscription/customer scoping for repairs and destructive actions.
- Prefer DB-backed behavioural, concurrency and fault-injection tests over source-regex assertions when behaviour can be tested directly.
- Do not remove compatibility code until importer/reachability checks prove it is no longer used.
- Current state must come from canonical state owners; raw SQL is acceptable for history/reporting where it does not create an independent business decision.
- Refactors must not silently change plan eligibility, billing, refund, inactivity, access, placement or notification policy.

## Completion policy

This PR should remain **draft** until all P0/P1 items are complete and all required workflows pass on the combined branch.

P2/P3 items may either be completed here or explicitly spun into follow-up PRs with links and rationale. If split, the checkbox should only be marked complete once the replacement PR is merged or the remaining work is deliberately re-scoped in this document.

Each completed item should add:

1. the implementation commit/PR reference,
2. regression tests or a short explanation of why existing tests are sufficient,
3. any compatibility layer intentionally retained,
4. any migration or operator action required.

---

# P0 — repository and release enforcement

## Required status checks on main

- [x] Inspect the current branch/ruleset configuration for `main`.
- [ ] Require the release-critical workflows before merge rather than relying on manual discipline.
- [ ] Require, where supported by the repository/ruleset:
  - CI
  - Release Integrity
  - Integration
  - Browser & Clean Install
  - Security CodeQL
  - Stremio
- [ ] Prefer merge queue / up-to-date branch enforcement so a PR proven green on an older base cannot bypass combined-main validation.
- [x] Add a repository-level regression/documentation check describing the required merge gates.
- [x] Confirm emergency/owner override behaviour is explicit rather than accidental.

**Done when:** a PR cannot normally merge into `main` without the intended green checks on a current base.

---

# P1 — finish canonical ownership cleanup

## 1. Thin `src/platform/admin-customer-360.js`

Current concern: this router is still a large business-mutation surface after surrounding admin/customer routes were thinned. It contains profile/account mutations, subscription expiry mutation, placement operations, policy/override operations and audit persistence alongside HTTP handling.

Target structure:

```text
src/platform/admin-customer-360.js
  -> HTTP / CSRF / validation / redirect / presentation only

src/customers/admin-customer-profile-service.js
src/access/admin-customer-access-settings.js
src/entitlements/admin-expiry-service.js
src/access/admin-server-placement-service.js
src/auth/admin-customer-identity-service.js
  -> business decisions / locking / transactions / audit
```

Tasks:

- [x] Inventory every route and mutation currently owned by `admin-customer-360.js`.
- [x] Move profile + portal identity mutation into a customer/auth domain service.
- [x] Move non-recurring expiry reset into the entitlement/access domain.
- [x] Move automatic server placement/reset orchestration behind an access-domain owner.
- [x] Move policy override mutation behind the canonical access/provisioning owner.
- [x] Move household/library/request-permission override mutation behind their domain owners.
- [x] Move email verification/admin identity mutation behind auth/customer identity ownership.
- [x] Move automation-protection mutation behind the relevant lifecycle/access owner.
- [x] Move renewal/plan-change cancellation decisions behind payments/access owners where not already delegated.
- [x] Keep route validation, CSRF, rate limiting, rendering and redirects in platform.
- [x] Add ownership tests preventing direct subscription/customer/user/audit mutation SQL from returning to the router.
- [x] Add behavioural tests for any extracted high-risk mutation.

**Done when:** the router contains no independent customer-access, subscription, identity or business-policy mutation logic.

## 2. Make Customer 360 current state fully canonical

Current concern: `customer-360.js` loads both raw/current subscription interpretations and `customer-access-state.snapshot()`, which can allow a read model to develop a second definition of “current”.

Tasks:

- [x] Define one Customer 360 read projection contract.
- [x] Source primary/free/Emby/Stremio **current access state** from `customer-access-state.snapshot()`.
- [x] Use raw subscription SQL for history/listing only.
- [x] Remove or narrow duplicate calls such as `currentEntitlementTruth()` where the canonical access snapshot already supplies the answer.
- [x] Make current lane naming/blocked semantics consistent with Account Home / My Access / Customer 360.
- [x] Add tests proving the same fixture produces the same current state across the three surfaces.
- [x] Preserve historical subscriptions, incidents, playback, audit and timeline reporting.

**Done when:** one canonical access snapshot drives all “what access does this customer have now?” UI decisions.

## 3. Create a canonical plan command service

Current concern: plan creation/editing/configuration-transfer can directly mutate overlapping plan/provider/server-eligibility state.

Tasks:

- [x] Introduce a catalog/domain command owner for plan creation and update.
- [x] Centralize plan validation and normalisation.
- [x] Centralize server eligibility persistence.
- [x] Centralize provider-price mapping persistence.
- [x] Centralize transactional audit persistence.
- [x] Make `admin-jellyfin-plan-editor.js` delegate mutations.
- [x] Make `admin-plan-create-v2.js` delegate mutations.
- [x] Make any other plan editor use the same owner.
- [x] Add behavioural tests for create/update rollback on partial failure.
- [x] Add ownership checks preventing plan mutation SQL from reappearing in platform editors.

**Done when:** every UI/import path uses the same transactional plan mutation service.

## 4. Turn configuration transfer into orchestration, not direct ownership

Current concern: `src/platform/configuration-transfer.js` is large and writes settings/plans/provider mappings/automation state directly.

Tasks:

- [x] Split parsing/validation of a transfer package from application of the package.
- [x] Reuse canonical settings/plan/automation command services.
- [x] Ensure imported plan/provider/server mappings pass the exact same validation as browser edits.
- [x] Keep all-or-safe-partial transaction semantics explicit.
- [x] Define which configuration classes are atomic together and which can be safely applied independently.
- [x] Add upgrade/import behavioural tests.
- [x] Add an ownership check preventing transfer code from bypassing canonical domain mutation services.

**Done when:** configuration transfer is a coordinator over canonical domain commands rather than a second administrative backend.

## 5. Standardise runtime container resolution

Current concern: recovery/watchdog bugs repeatedly came from branded container names being copied into shell scripts.

Tasks:

- [x] Add one shell/runtime helper that resolves a Compose service via `docker compose ps -q <service>`.
- [x] Resolve `app`, `postgres`, `automation-worker`, `activity-worker`, `backup-worker` by service identity.
- [x] Remove hard-coded runtime container names from watchdog/recovery/deployment checks where not required by Compose itself.
- [x] Keep legacy-name adoption only in the explicit migration/adoption path.
- [x] Extend runtime recovery behavioural tests to prove service-name resolution works independently of physical container name.
- [x] Search for remaining `steam-fusion*` / `captainfin*` runtime-name coupling and classify each occurrence as compatibility, display, or bug.

**Done when:** another product/container rename cannot break health/recovery scripts.

## 6. Build one immutable runtime image per commit

Current concern: the Compose services use the same repository/image contents but are built as separate service targets.

Tasks:

- [x] Define one canonical image tag using the Git commit/build SHA.
- [x] Build it once during deployment.
- [x] Run app/automation/activity/backup/migrate/recovery with service-specific commands from the same image.
- [x] Preserve migration and recovery profiles.
- [x] Preserve immutable previous image IDs required for safe runtime rollback.
- [x] Update deployment tests to verify all runtime services report the same intended build SHA.
- [x] Confirm resource limits, read-only roots, tmpfs and DB-role isolation remain service-specific.

**Done when:** one release commit corresponds to one reusable runtime image rather than redundant builds of the same source tree.

---

## 7. Unify provider financial identity and transaction truth

Current concern: Stripe, PayPal and Plisio historically exposed overlapping but incomplete views of payment identity, transaction history, provider reconciliation and customer ownership. A provider payment could therefore exist while Customer 360 showed no transaction or no usable provider identity.

Tasks:

- [x] Establish one provider financial-state owner for customer/provider identities and transaction ownership repair.
- [x] Make Stripe, PayPal and Plisio share one canonical transaction ledger.
- [x] Allow verified Plisio settlements into `payment_history_transactions` rather than synthesizing them only in a view.
- [x] Add a single scheduled provider financial reconciliation job covering Stripe catch-up, PayPal reconciliation, Plisio local evidence and ownership repair.
- [x] Keep the former PayPal-only scheduled key as a no-op compatibility entry while operators/configuration migrate.
- [x] Backfill missing `payment_customers` mappings from unambiguous provider subscriptions.
- [x] Repair unowned transaction rows only when all available local evidence resolves to exactly one customer.
- [x] Record Stripe refund ledger rows from authenticated Stripe webhook data while preserving the existing incident workflow.
- [x] Make Customer 360 read the canonical financial projection and show provider identities, provider transaction IDs and unresolved-link warnings.
- [x] Add direct Stripe search links from Customer 360 so refunds/support do not depend on manually rediscovering the Stripe customer.
- [x] Make the global transaction browser include Plisio and use the unified reconciliation owner.
- [x] Extend smoke coverage for the unified automation registry, transaction classifier/browser, Stripe catch-up and Plisio ledger path.

**Done when:** a successful provider payment has one durable financial record and one unambiguous customer identity path, regardless of whether it arrived by browser return, webhook, provider-history catch-up or later repair.

# P2 — simplify runtime, automation, tests and views

## 8. Remove CI-only material from the production image

Current concern: Docker currently uses `COPY . .`; the runtime image therefore contains the large smoke/audit/test estate and documentation even though most is never executed in production.

Tasks:

- [x] Classify scripts as runtime/operator/recovery vs CI/test-only.
- [x] Introduce a clear directory convention such as:
  - `scripts/runtime/`
  - `scripts/ops/`
  - `scripts/ci/`
- [x] Update npm scripts/workflows incrementally rather than in one risky rename.
- [x] Change Docker build COPY rules or stages so CI-only test scripts and non-runtime docs are omitted from the final production image.
- [x] Keep migration, backup, restore, environment preparation and deployment verification tools available where required.
- [x] Add an image-content smoke test for required runtime tools and forbidden CI-only content.
- [x] Compare image size before/after.

**Done when:** the production image contains only the application and tools needed to operate/recover it.

## 9. Finish the automation registry design

Current state: the registry now exposes `run`, `defaultIntervalSeconds`, `critical`, `timeoutMs` and `concurrencyClass`, but timeout/concurrency metadata is largely declarative rather than enforced.

Tasks:

- [x] Decide whether per-job timeout is required. If yes, enforce `timeoutMs`; if no, remove the unused field.
- [x] Define meaningful concurrency classes where jobs should not share the same scheduler capacity/DB pressure class.
- [x] Enforce `concurrencyClass` in the worker if retained.
- [x] Move remaining job metadata into one canonical registry module.
- [x] Retire `job-metadata.js` once definitions no longer need a separate metadata table.
- [x] Retire `critical-jobs.js` compatibility facade after importer checks prove no production callers require it.
- [x] Keep DB pool/control headroom and reconciliation/maintenance-lock budgets.
- [x] Add scheduler behavioural tests for timeout, class contention and shutdown/drain semantics.

**Done when:** automation scheduling policy has one executable source of truth rather than metadata placeholders and compatibility layers.

## 10. Consolidate the test estate without losing behavioural coverage

Current concern: the repository has hundreds of one-off smoke/check scripts and very long package-script command chains.

Tasks:

- [x] Keep the current tagged manifest as the transition source of truth.
- [x] Introduce shared DB fixture builders with scoped setup/cleanup.
- [x] Make tagged suites independently runnable without relying on side effects from prior tests.
- [x] Prefer `node:test` suites/modules for related tests rather than one process/file per assertion group where practical.
- [x] Consolidate repeated helpers for:
  - temporary PostgreSQL schema/database setup
  - environment overrides
  - fake provider clients
  - transaction/concurrency barriers
  - fixture customer/plan/subscription creation
- [x] Preserve all race, rollback, provider ambiguity, access, backup and migration tests.
- [x] Replace source-regex assertions with behavioural tests where feasible.
- [x] Keep static ownership assertions where they enforce architectural boundaries that behaviour alone cannot identify.
- [x] Simplify `package.json` scripts to stable suite/tag entrypoints.
- [x] Keep CI workflow intent visible even after suite consolidation.

**Done when:** test coverage remains at least as strong but suite composition is understandable without maintaining hundreds of bespoke runners.

## 11. Collapse transitional Customer 360 rendering layers

Current concern: Customer 360 rendering is spread over multiple transitional files and includes regex manipulation of generated HTML.

Tasks:

- [x] Inventory:
  - `customer-360-view.js`
  - `customer-360-view-v2.js`
  - `customer-360-compact.js`
  - `customer-360-access-cards.js`
  - `customer-360-service-truth.js`
  - related helpers
- [x] Define one component/rendering tree.
- [x] Remove regex-based HTML surgery used to relocate/remove actions.
- [x] Make action placement explicit in the renderer.
- [x] Remove obsolete V1/V2 compatibility layers after screenshot/behaviour tests prove parity; retain `customer-360-compact.js` as the canonical active renderer.
- [x] Preserve accessibility/mobile/admin workflow tests.

**Done when:** Customer 360 is rendered from one intentional component hierarchy with no post-render regex rewriting.

## 12. Formalise financial/date boundary types

Tasks:

- [x] Define application conventions:
  - PostgreSQL `DATE` -> ISO `YYYY-MM-DD` string
  - instant -> UTC timestamp / Date
  - duration -> explicit seconds/milliseconds/interval contract
- [x] Apply the convention at DB reader boundaries.
- [x] Audit expense dates, import ranges, accounting periods and report filters.
- [x] Extend timezone test matrices to UTC, Europe/London, America/New_York and a positive-offset timezone.
- [x] Search for `new Date()` or implicit pg date conversion on calendar-date fields.
- [x] Keep elapsed-duration arithmetic separate from calendar-duration arithmetic.

**Done when:** changing the Node process timezone cannot alter financial coverage dates or prepaid elapsed duration.

## 13. Move customer security mutations out of platform

Current concern: `src/platform/customer-security.js` still performs TOTP/recovery/session/user mutation SQL.

Tasks:

- [x] Move TOTP enrollment/confirmation/disable state into auth/security domain services.
- [x] Move recovery-code generation/replacement into the same owner.
- [x] Move session revocation/password-security mutations behind auth ownership.
- [x] Keep routes, CSRF, rate limits and rendering in platform.
- [x] Preserve current security logging/auditing.
- [x] Add behavioural security tests and boundary assertions.

**Done when:** platform security routes no longer own authentication persistence rules.

---

# P3 — remove compatibility debt and standardise helpers

## 14. Retire compatibility facades deliberately

Candidates include compatibility shims/facades introduced while moving ownership out of platform and automation.

Tasks:

- [x] Produce an importer report for compatibility modules.
- [x] Mark compatibility-only exports/modules explicitly.
- [x] Prevent new production callers through ownership/static checks.
- [x] Remove each facade only after production importer count reaches zero.
- [x] Remove corresponding compatibility assertions once the old surface is gone.
- [x] Keep compatibility where it protects upgrade/runtime interfaces, not merely because it already exists.

**Done when:** transitional compatibility code has an explicit lifecycle instead of becoming permanent accidental architecture.

## 15. Standardise platform/UI helpers

Tasks:

- [x] Inventory duplicate helpers for:
  - HTML escaping
  - CSRF hidden inputs
  - confirmation parsing
  - date/time rendering
  - notice/error redirects
  - pills/status tones
  - admin form rows/buttons/cards
- [x] Establish canonical helpers/components.
- [x] Migrate modules gradually.
- [x] Keep feature-specific rendering local where abstraction would make code harder to read.
- [x] Add tests preventing unsafe raw HTML interpolation in canonical form helpers.

**Done when:** common UI mechanics have one implementation while domain-specific presentation remains explicit.

## 16. Review oversized read-model/platform modules

Do not split files solely because they are large. Split only where the module currently owns multiple independent reasons to change.

Initial review candidates:

- [x] `src/platform/admin-customers-list.js`
- [x] `src/platform/admin-orders.js`
- [x] `src/platform/admin-billing.js`
- [x] `src/platform/admin-stremio-sources.js`
- [x] `src/integrations/request-user-sync.js`
- [x] `src/payments/customer-plan-change.js`
- [x] `src/payments/lifecycle.js`
- [x] `src/jellyfin/activity.js`

For each candidate:

- [x] identify read model vs command vs rendering vs transport responsibilities,
- [x] remove duplicated business decisions,
- [x] leave cohesive modules intact when splitting adds indirection without ownership benefit.

---

# Cross-cutting standardisation targets

These are principles to apply opportunistically while completing the prioritized work, not excuses for unrelated rewrites.

- [x] One canonical current customer access snapshot.
- [x] One owner for each destructive mutation.
- [x] One provider capability/transport boundary.
- [x] One durable external-notification path.
- [x] One plan mutation contract.
- [x] One automation registry.
- [x] One runtime Compose service-resolution mechanism.
- [x] One date/time boundary convention.
- [x] One test fixture layer for shared database/provider scenarios.
- [x] One explicit UI component/helper for repeated mechanics.
- [x] No new direct business SQL in `src/platform` without a documented exception.
- [x] No new compatibility facade without a retirement condition.

---

# Suggested implementation order

To keep merge risk low, work through the branch in this order:

1. Repository/ruleset enforcement.
2. Customer 360 mutation extraction.
3. Customer 360 canonical read projection.
4. Plan command service.
5. Configuration-transfer orchestration.
6. Runtime service-name resolution.
7. Single immutable runtime image.
8. Financial date contracts.
9. Automation registry completion.
10. Customer security mutation extraction.
11. Customer 360 renderer consolidation.
12. Test-estate consolidation.
13. Production-image slimming.
14. Compatibility-facade retirement.
15. Remaining oversized-module review and UI helper standardisation.

Where possible, keep each numbered item in its own commit or small sequence of commits so it can be reviewed/reverted independently.

---

# Validation required before this PR leaves draft

- [x] `npm run check:fast`
- [x] `npm run check:db`
- [x] strict dead-code audit
- [x] canonical ownership/boundary checks
- [x] clean-install workflow
- [x] previous-schema upgrade workflow
- [x] Integration
- [x] Browser & Clean Install
- [x] Stremio
- [x] Security CodeQL
- [x] Release Integrity
- [x] deployment tooling/recovery behavioural tests
- [x] no reduction in high-risk concurrency/fault-injection coverage
- [x] combined branch rebased/updated on current `main` before final merge

## Production acceptance

Before final merge/deployment of the completed roadmap:

- [x] create an encrypted pre-deploy backup,
- [x] deploy only through the supported deployment helper,
- [x] confirm all runtime services report the intended build SHA,
- [x] run live `npm run verify:deployment`,
- [x] confirm critical automation jobs are healthy,
- [x] check Access Integrity / revenue-integrity findings,
- [ ] review any manual-review provider operations rather than retrying them blindly.

---

# Progress log

- 2026-10-02 — Live production deployment acceptance advanced on build `90494f04`: deployment used the supported helper, created an encrypted pre-deploy PostgreSQL backup, validated candidate worker SHAs, passed candidate verification, cut over the web app, and passed live post-cutover `npm run verify:deployment`. Critical automation health passed; Revenue Integrity executed and surfaced two `free_plan_without_ready_server` findings for operator follow-up. The final manual-review provider-operation review remains open because the acceptance audit script was accidentally excluded from the runtime image by the generic `scripts/*-audit.js` Docker ignore pattern; PR #865 fixes packaging and adds built-image assertions to Release Integrity and Merge Safety.

- 2026-10-02 — Final destructive-mutation ownership closeout: PR #857 rebased the remaining customer-creation, customer-management and portal-credential ownership work onto current `main`, removed the final seven frozen `src/platform` domain-table mutation exceptions, and passed CI, Integration, Release Integrity, Browser & Clean Install, Security CodeQL and Stremio. `platform-business-sql-boundary-smoke.js` now reports zero frozen legacy platform/table exceptions and rejects any future direct mutations of the protected domain tables.
- 2026-10-02 — Tagged-suite independence validated from clean jobs: `fast`, `db`, `billing`, `access`, `browser` and `security` were each run in an isolated GitHub Actions job with a fresh PostgreSQL service and freshly migrated schema. The evidence run exposed one real hidden dependency in `provider-checkout-recovery-db-smoke.js` (Premium capacity was inherited from an earlier test); PR #853 made that test create/clean its own Premium server fixture. The rerun then passed all six isolated tags.

- 2026-10-02 — Production-image size comparison completed on the same post-#845 code baseline. A temporary non-merge measurement branch restored the pre-cleanup Docker build context and measured `200,788,295` bytes; the normal production exclusions measured `197,942,068` bytes. The CI/test/documentation exclusions therefore reduce the runtime image by `2,846,227` bytes (about `1.42%`) while Release Integrity confirms the required runtime/operator/recovery tools remain present.


- 2026-10-02 — Final compatibility-scaffolding cleanup: the full CI run on the preceding ownership branch reported no marked compatibility facades remaining under `src/`. Removed the zero-importer `scripts/db-test-fixture.js` transitional alias, retired the now-empty compatibility importer report from the fast suite, and kept only compatibility behavior that protects explicit upgrade/runtime interfaces rather than historical module surfaces. Canonical ownership guards that prevent retired mutation owners from being reintroduced remain intentionally in place.

- 2026-10-02 — Post-merge closeout for PR #829: final head `6debf1f` was current with `main` before merge and all six release-critical workflows passed (CI, Integration, Release Integrity, Browser & Clean Install, Security CodeQL, Stremio). The successful suites cover tagged fast checks, the full DB suite, strict dead-code audit, previous-schema upgrade, clean-install, canonical ownership, deployment/recovery behaviour and the retained high-risk concurrency/recovery tests. The merged `platform-business-sql-boundary-smoke.js` also freezes the documented legacy platform/domain-table mutation exceptions and rejects any new direct mutation without deliberate review. Remaining unchecked items are intentionally limited to repository-admin enforcement, image-size baseline comparison, tagged-suite independence follow-up, compatibility retirement follow-up, residual destructive-mutation ownership, and live production acceptance.

- 2026-10-02 — Began actual process/file consolidation with `node:test`: the new fixture-layer and provider-boundary contracts now live together in `scripts/ci/roadmap-contracts.test.js`, replacing two standalone smoke executables. Older high-risk DB/concurrency tests remain separate where process isolation is part of their safety value.

- 2026-10-02 — Established `scripts/test-fixture.js` as the canonical shared test-fixture layer: DB lifecycle/rollback/timezone helpers, scoped environment overrides, unique IDs, concurrency barriers, module/provider mocking and customer/plan/subscription builders now live together. `db-test-fixture.js` is a transitional re-export; payment-event replay and provider-checkout recovery were migrated to the canonical helper, and fixture code is excluded from production images.

- 2026-10-02 — Provider capability/transport ownership is now executable: `provider-boundary-smoke.js` prevents platform/access/entitlement/automation code from importing Stripe SDK or lifecycle/refund HTTP adapters directly, while billing continues through `provider-contract.js`. Added the check to the fast customer-access suite.

- 2026-10-02 — Completed the duplicate UI-helper inventory with `scripts/ui-helper-inventory.js` and `docs/UI_HELPER_INVENTORY.md`. Security-sensitive/shared mechanics have named canonical owners; feature-specific date/status/card rendering remains local where consolidation would add indirection rather than reduce risk.

- 2026-10-02 — Reconciled cross-cutting completion markers with the implemented contracts already enforced elsewhere in this branch: canonical customer access state, durable notification outboxes, plan mutation ownership, automation registry ownership, Compose service resolution and shared UI primitives are now marked complete. Broader destructive-mutation/provider/test-fixture boundaries remain open where the roadmap still has real work.

- 2026-10-02 — Test entrypoints now converge on the tagged manifest without removing any underlying checks: CI runs the explicit `fast` tag, `npm test`-style `check` resolves through the same tag runner, and stable `check:billing`, `check:access`, `check:browser` and `check:security` aliases expose intent without another bespoke command graph. Existing granular suites remain available during the incremental migration.

- 2026-10-02 — Repaired CI drift after Customer 360 renderer consolidation: `customer-billing-tab-smoke.js` now asserts renewal, plan-change and payment-history/refund boundaries against canonical `customer-360-compact.js` instead of importing the deliberately deleted V2 renderer. No retired compatibility layer was restored.

- 2026-10-02 — Synced the roadmap branch onto current `main` after #830 without overwriting roadmap work. The branch now contains the zero-downtime Stremio refresh migration/contracts and Git history records `main` as a merge parent, so combined-base validation is against the current default branch.

- 2026-10-02 — Retired `src/jellyfin/provisioning.js` after its production importer count reached zero. Reconciliation callers now use `resilient-provisioning`, dependency-safe helper callers use `provisioning-helpers`, the compatibility importer audit fails on any new production facade caller, and a circular-dependency regression exposed during CI was removed rather than restoring the shim.

- 2026-10-02 — Customer portal password validation now has one canonical `customer-password-policy` owner shared by registration/reset and security-command password changes; stale static assertions were updated to test the canonical boundary.

- 2026-10-02 — Re-verified the active `Protect main` ruleset: `bypass_actors` is empty and the connected user cannot bypass it, so owner/emergency bypass behaviour is explicit. Required status checks/merge-queue enforcement remain the unresolved repository-admin P0 action.


- 2026-10-02 — Oversized-module ownership review completed in `docs/OVERSIZED_MODULE_REVIEW_2026-10-02.md`. Large payment state machines are intentionally kept cohesive; platform read/render modules are not split for size alone; Stremio source admin, lifecycle policy configuration and activity read models are identified as future split candidates only where ownership becomes clearer. `admin-orders.js` already shed duplicate date/CSRF mechanics during the review.

- 2026-10-02 — Added concrete `scripts/ci/`, `scripts/runtime/` and `scripts/ops/` conventions with compatibility rules. Existing entrypoint paths are intentionally not bulk-moved; new/migrated script families can adopt the directories incrementally, and CI-only directory/docs are excluded from the runtime image.

- 2026-10-02 — Compatibility debt now has an executable importer report (`scripts/compatibility-importer-report.js`). `src/jellyfin/provisioning.js` is explicitly marked with its retirement condition, and the report is part of operations checks while remaining excluded from the runtime image. No facade will be deleted until the report proves production importer count reaches zero.

- 2026-10-02 — UI-helper standardisation started with a canonical `src/platform/html-primitives.js` for HTML escaping and CSRF hidden inputs. Admin shell/UI and Customer 360 now share it, with hostile-input regression coverage preventing unsafe interpolation. Feature-specific cards remain local; broader helper inventory/migration remains incremental.

- 2026-10-02 — Production-script classification formalised in `docs/SCRIPT_CLASSIFICATION.md`; runtime/worker and operator/recovery tools are explicitly separated from CI-only smoke/audit helpers. `.dockerignore` now also excludes `*-audit.js`, `smoke-db.js` and `db-test-fixture.js`, closing additional test-helper leakage into the production image without a risky bulk path rename.

- 2026-10-02 — Test-estate consolidation started without removing coverage: added `scripts/db-test-fixture.js` for shared DB lifecycle, rollback scopes and timezone loops; migrated payment-history timezone, business-expense timezone and catalog rollback regressions onto it. Tagged manifest remains the suite source of truth; broader node:test/process consolidation remains open.

- 2026-10-02 — Customer 360 rendering consolidation advanced: deleted retired `customer-360-view-v2.js`, moved the only still-used record/portal nav into the unified wrapper, removed zero-caller HTML-surgery compatibility shims, and updated renderer contracts. `customer-360-compact.js` is now explicitly the canonical action-first renderer rather than a transitional compatibility layer.

- 2026-10-02 — Financial/calendar-date boundary completed: PostgreSQL `DATE` values are treated as canonical `YYYY-MM-DD` text, expense and payment-history readers cast DATE columns to text, expense rendering now uses the shared UTC calendar-date helper, four-timezone DB regressions cover expense/history ranges, elapsed prepaid duration remains epoch-based, and a static boundary check prevents implicit `new Date(row.<calendar_date>)` regressions.

- 2026-10-01 — Began production-image slimming: Docker build context now omits docs plus CI smoke/check runners while retaining runtime/backup/migration/recovery verification tools. Release Integrity builds the actual image and asserts required/forbidden paths. Current exclusions remove about 2.76 MB across 349 repository files before layer compression.

- 2026-10-01 — Customer security mutation ownership completed: TOTP/recovery/password/session mutations live behind `customer-security-commands`; platform routes retain HTTP/CSRF/rendering only, `customers.js` keeps compatibility wrappers, and behavioral plus canonical-ownership checks prevent persistence from drifting back into platform.

- 2026-10-01 — Closed the remaining high-risk Customer 360 extraction coverage: reset-to-plan expiry now has behavioral proof for subscription locking, customer scoping, extension clearing, atomic audit and reconciliation; automatic placement covers place/already/migrate/no-target paths through canonical migration/reconciliation owners.

Add dated entries here as implementation batches land.

- 2026-10-01 — Roadmap created from green baseline `413b366` after PR #828.
- 2026-10-01 — P0 ruleset audit: active `Protect main` ruleset requires PRs and blocks deletion/non-fast-forward, but has no required-status-check rule. Current GitHub integration can read but cannot administer branch protection/rulesets; required-check enforcement remains an explicit repository-admin action.
- 2026-10-01 — Added `docs/REPOSITORY_MERGE_GATES.md` plus `repository-merge-gates-smoke.js`: the six release-critical workflow names and PR triggers are now source-controlled and machine-checked, including exact-head/current-base and emergency-bypass expectations. Actual required-check/merge-queue enforcement still needs repository-admin configuration.
- 2026-10-01 — Reconciled Customer 360 roadmap against baseline: mutation ownership and canonical current-state projection were already substantially complete. Fixed a live `permanentAccess.status()` missing-import regression and added coverage.
- 2026-10-01 — Continued plan ownership cleanup: `admin-plans.js` overview/archive/unarchive mutations now delegate to `src/catalog/plan-command-service.js`; added a platform ownership regression guard. Plan validation/normalisation and transactional rollback coverage remain open.
- 2026-10-01 — First CI cleanup pass: updated stale Stremio ownership assertions/stubs after catalog-command extraction, removed dead `configuration-transfer.lower()`, and updated the permanent-access UX smoke to follow the canonical access-command owner instead of expecting direct router mutation.
- 2026-10-01 — Began shared plan validation standardisation with `src/catalog/plan-input.js`; creation plus Jellyfin/Stremio/Emby/overview editors now share primitive boolean/text/integer/money normalization. Added fast contract coverage and a DB regression proving a failed audit write rolls the entire plan overview mutation back. Higher-level product-specific validation remains intentionally open.
- 2026-10-01 — Configuration-transfer audit confirmed parsing/application are separated and atomic application already delegates settings, notification preferences, plans/provider mappings and automation state to their canonical owners. Exact shared plan-validation parity and a static no-bypass ownership guard remain open.
- 2026-10-01 — Began P1 implementation: Customer 360 manual server assignment and Permanent Access now cross `src/access/admin-customer-access-commands.js`; canonical ownership checks prevent platform bypass.
- 2026-10-01 — Customer 360 service truth/control reads now prefer `customer-access-state.snapshot()` whenever present. Added regression coverage preventing stale subscription-history rows from being resurrected as current access.
- 2026-10-01 — P0 audit confirmed the active `Protect main` ruleset enforces PR/thread rules but currently has no required Actions/status-check rule. Repository-administration write access is not available through the connected GitHub integration, so enforcement remains an owner/admin action.
- 2026-10-01 — Began canonical plan commands: new `src/catalog/plan-command-service.js` owns atomic plan creation, default price persistence and audit. `admin-plan-create-v2.js` now delegates persistence and retains only HTTP/form compatibility responsibilities.
- 2026-10-01 — Expanded catalog ownership across Jellyfin plan product, access, availability, server placement, libraries, commerce, portal-currency price and payment mappings. Platform editors now retain validation/rendering/provider verification but not those transactions.
- 2026-10-01 — Moved Stremio plan commerce/storefront/access tracking/availability/payment persistence behind the same catalog command service and updated architectural tests to enforce the shared ownership boundary.
- 2026-10-01 — P0 inspected: active repository ruleset `Protect main` requires PRs/thread resolution but currently has no required-status-check rule. The available GitHub connector exposes ruleset reads only, so the settings change remains an explicit repository-admin action rather than being falsely marked complete.
- 2026-10-01 — P1 Customer 360 thinning in progress: profile/portal identity, email verification, automation protection, reset-to-plan expiry, automatic placement, policy/household/library/request overrides, Stremio household reset and renewal subscription selection moved behind domain owners. `admin-customer-360.js` no longer imports the DB module or contains direct mutation SQL. Behavioural coverage for the newly extracted high-risk placement/expiry paths remains to be completed before this item is closed.
- 2026-10-01 — Closed remaining plan/import ownership work: `plan-contract.js` is now the shared command/import validation boundary, configuration transfer uses it for imported plans/provider mappings, and `canonical-ownership-smoke.js` forbids transfer-side direct writes.
- 2026-10-01 — Runtime identity standardisation complete: watchdog, recovery and deployment resolve Compose services through `scripts/lib/compose-runtime.sh`; branded names remain only for explicit legacy-container adoption/display compatibility. Behavioural tests resolve mock service IDs independently of physical names.
- 2026-10-01 — Single-image release model complete: deployment builds one `captainfin:<git-sha>` image, all Node runtime/migrate/recovery services consume it with service-specific commands, prior image IDs remain available for safe app-only rollback, and deployment verifies build SHA consistency before advancing `captainfin:current`.
- 2026-10-01 — Automation registry cleanup completed: unused timeout/concurrency placeholders were removed instead of left declarative, metadata now lives with executable job definitions in `jobs.js`, retired `job-metadata.js`/`critical-jobs.js` facades are guarded against reintroduction, and existing worker tests retain bounded concurrency, DB headroom and drain behaviour.
