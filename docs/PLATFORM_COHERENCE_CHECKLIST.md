# Platform Coherence — 71/71 implementation checklist

This document maps the full pre-release audit to the implementation on `agent/platform-coherence-full-sweep`.

The status **Implemented** means the item has a connected runtime path (schema/service/UI/job as applicable), not merely a helper or design note. Cross-cutting behavior is additionally protected by `scripts/platform-coherence-static-smoke.js`, `scripts/assembled-app-smoke.js`, `scripts/platform-coherence-db-smoke.js`, and the Platform Coherence workflow.

| # | Audit item | Status | Connected implementation |
|---:|---|---|---|
| 1 | Monthly reseller dashboard owns `/reseller` | Implemented | `src/application.js`, `src/platform/reseller-monthly-portal.js` |
| 2 | Reseller plans appear through the canonical public storefront | Implemented | `src/platform/storefront.js`; secondary reseller storefront router removed |
| 3 | Replace preload/route monkey-patch composition | Implemented | `src/application.js`; `package.json` starts canonical composition |
| 4 | Make `free_claim` a valid subscription source | Implemented | migration 036; `src/payments/lifecycle.js` |
| 5 | Block reseller-only plans from customer checkout | Implemented | `src/payments/lifecycle.js`, flexible checkout server-side audience checks |
| 6 | Block reseller-only plans from free claims/trials | Implemented | `assertDirectPlan()` in `src/payments/lifecycle.js` |
| 7 | Close reseller seat-limit resume bypass | Implemented | atomic reseller lock + `assertSeatAvailable()` in `src/resellers/monthly.js` |
| 8 | Replace single access-hold reason with composable holds | Implemented | migration 036; `src/entitlements/access-holds.js` |
| 9 | Prevent duplicate reseller recurring agreements | Implemented | checkout intents + DB recurring trigger + migration 044 fix |
| 10 | Prevent duplicate direct recurring agreements | Implemented | checkout intents + DB recurring trigger + controlled plan changes |
| 11 | Define one canonical effective subscription | Implemented | `src/entitlements/subscription-state.js`, supersession columns |
| 12 | Never rewrite provider subscription during reseller renewal | Implemented | source rewrite guards in reseller entitlement flow |
| 13 | Protect provider subscription from legacy credit renewal | Implemented | source rewrite guards in legacy credit compatibility path |
| 14 | Remove hard-coded public `import_users.js` inventory | Implemented | file removed; static contract prevents return |
| 15 | Rewrite README for PostgreSQL/current architecture | Implemented | `README.md` |
| 16 | Remove obsolete JSON `check-expired.js` | Implemented | file removed; DB reconciliation is canonical |
| 17 | Make reseller estate reconciliation transition-idempotent | Implemented | `src/resellers/monthly.js` only reconciles changed holds |
| 18 | Remove/fix stale reseller analytics query | Implemented | canonical period-aware `salesAnalytics()` in monthly service |
| 19 | Do not sum reseller MRR across currencies | Implemented | admin commerce/reseller reporting groups currencies separately |
| 20 | Prevent mixed-currency downstream reseller totals | Implemented | one configurable ledger currency per reseller |
| 21 | Do not count reseller own £0 access as revenue | Implemented | explicit `owner_access` sale type excluded from revenue |
| 22 | Append-only reseller sales ledger | Implemented | migration 036/041; `src/resellers/ledger.js`; refund/void/adjustment entries |
| 23 | Configurable reseller ledger currency | Implemented | reseller defaults + per-reseller setting/UI |
| 24 | Configurable reseller payment methods | Implemented | reseller defaults + per-reseller method list |
| 25 | Version/grandfather reseller tier terms | Implemented | tier term snapshots on reseller subscription |
| 26 | Verify Stripe/PayPal reseller mappings | Implemented | `validateTierMapping()` in `reseller-billing-v2-core.js` |
| 27 | Reseller upgrade/downgrade flows | Implemented | Stripe upgrade now; scheduled downgrade; PayPal-safe replacement semantics; seat-boundary guard |
| 28 | Reseller grace/dunning controls | Implemented | migration 043; `src/resellers/dunning.js`; admin Dunning page |
| 29 | Separate refunds/disputes/payment failure from access policy | Implemented | commerce event reporting; reseller refund preserves paid-through; ledger corrections are accounting-only |
| 30 | Bind PayPal return to checkout intent | Implemented | single-use checkout intent/state verification |
| 31 | Consistent authenticated mutation CSRF/same-origin enforcement | Implemented | customer mutation guard, router CSRF, application same-origin middleware |
| 32 | Rebuild People → Resellers around monthly model | Implemented | `admin-resellers.js`, monthly Reseller 360 |
| 33 | Separate reseller portal/estate/renewal controls | Implemented | independent controls in reseller admin 360 |
| 34 | Update Admin Preview for monthly reseller model | Implemented | `src/platform/admin-preview.js` |
| 35 | Replace admin-generated reseller password with activation link | Implemented | account activation token/email flow |
| 36 | Replace admin-generated direct customer password with activation link | Implemented | account activation token/email flow |
| 37 | Remove fake routine repeated 2FA form fields | Implemented | plan/customer/branding flows rely on authenticated admin session; real 2FA remains login/security policy |
| 38 | Replace credit-first reseller defaults | Implemented | `reseller_defaults_v2`: currency, methods, owner access, default tier |
| 39 | Tier-specific downstream plan eligibility | Implemented | `reseller_tier_plan_rules` and tier catalogue UI/service |
| 40 | Clarify a reseller seat | Implemented | seat = active customer entitlement; labels and enforcement aligned |
| 41 | Portable configuration V2 | Implemented | V1-compatible V2 with quotas, tiers, rules, non-secret mappings, automation, drift policy |
| 42 | Setup Readiness understands direct vs reseller commerce | Implemented | `src/platform/setup-readiness.js` |
| 43 | Canonical integration status sources | Implemented | provider/request/email settings services reused by setup/readiness |
| 44 | Remove obsolete `JELLYFIN_ALLOWED_HOSTS` readiness requirement | Implemented | readiness script and static regression contract |
| 45 | Production Readiness understands browser-managed integrations | Implemented | canonical provider/request/email/placement services |
| 46 | Move recurring mutation jobs out of web process | Implemented | dedicated `automation-worker` Compose service + advisory locks |
| 47 | Browser-manage automation schedules | Implemented | `automation_job_state`; `/admin/automation` |
| 48 | Job Health / Run Now | Implemented | persistent duration/success/error/processed/next-run UI |
| 49 | Persistent customer login/reset throttling | Implemented | database-backed customer rate limiter |
| 50 | Exact assembled-application route test | Implemented | `scripts/assembled-app-smoke.js` |
| 51 | Duplicate critical-route detector | Implemented | recursive route contract in assembled-app smoke |
| 52 | Recursive JavaScript syntax checking | Implemented | `scripts/check-js-syntax.js`; `npm run syntax` |
| 53 | Remove superseded duplicate/dead modules | Implemented | obsolete reseller portal/storefront and JSON scripts removed; canonical wrappers prune compatibility routes |
| 54 | Reduce secure-start/preload runtime ownership | Implemented | canonical `src/application.js`; compatibility startup no longer owns business routes |
| 55 | Stop mutating `process.env.SITE_NAME` at runtime | Implemented | runtime settings service; static contract rejects mutation |
| 56 | Shared branding storage for replicas | Implemented | migration 040; PostgreSQL logo/favicon with legacy import |
| 57 | Remove unused Compose proxy network | Implemented | `docker-compose.yml`; static contract |
| 58 | Monthly reseller lifecycle notifications | Implemented | transition observer job for payment/grace/estate/tier/seat/customer expiry events |
| 59 | Do not claim unsupported WhatsApp notification readiness | Implemented | supported channels/UI limited to implemented delivery paths |
| 60 | Reseller seat-usage alerts | Implemented | lifecycle notification observer + dashboard utilisation warnings |
| 61 | Reseller profitability analytics | Implemented | downstream ledger revenue vs parent monthly fee, occupancy/seat analytics |
| 62 | Admin reseller/direct MRR/ARR/churn panels | Implemented | `/admin/commerce`; reseller-reported downstream sales explicitly excluded |
| 63 | Unified event/timeline centre | Implemented | `/admin/events` |
| 64 | Global admin search | Implemented | `/admin/search` |
| 65 | Configuration dependency warnings | Implemented | `/admin/configuration-health` |
| 66 | Impact previews for risky plan edits | Implemented | affected counts + typed plan-code confirmation; archive preview |
| 67 | Customer plan-change workflow | Implemented | Stripe controlled upgrade/downgrade; PayPal paid-through-safe flow |
| 68 | Customer subscription/payment history | Implemented | `/account/history` + portal links |
| 69 | Explicit free/trial eligibility configuration | Implemented | Commerce browser policy; automatic free downgrade option |
| 70 | Keep README/Roadmap/current architecture aligned | Implemented | rewritten `README.md` and `ROADMAP.md` |
| 71 | Reserve migration 016 and port Policy Drift onto current schema | Implemented | `016_reserved_legacy_gap.sql`, migration 042, drift engine/admin UI/worker/current-schema smoke |

## Regression gates

The giant PR is not considered complete merely because this table says 71/71. Its final head must pass:

- recursive JavaScript syntax checking;
- static architecture/coherence contract;
- exact assembled Express route ownership and duplicate-route detection;
- the complete PostgreSQL migration chain;
- cross-feature entitlement/billing/access-hold/reseller-term invariants;
- current-schema read-only Jellyfin Policy Drift smoke;
- Production Readiness execution;
- all existing pull-request workflows for customer, reseller, billing, provisioning, storefront, invitation, clean-install and configuration behavior.

No production deployment is implied by this checklist. Deployment occurs only after the PR is merged and the production host pulls/builds the merged `main` revision.
