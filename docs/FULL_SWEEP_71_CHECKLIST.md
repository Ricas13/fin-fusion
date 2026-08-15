# Platform coherence full sweep — 71/71 acceptance checklist

This manifest is the acceptance contract for the single platform-coherence PR requested after the full code/workflow sweep. An item is checked only when the relevant schema/service/runtime/UI or regression guard is present on this branch. `scripts/full-sweep-71-smoke.js` verifies this manifest and the highest-risk implementation contracts.

- [x] 01. Canonical monthly reseller dashboard owns `/reseller` — `src/application.js`, `src/platform/reseller-monthly-portal.js`.
- [x] 02. Canonical public storefront owns `/` and renders reseller tiers through the primary storefront renderer — `src/platform/storefront.js`, `src/platform/storefront-core.js`.
- [x] 03. Production application composition is explicit instead of route-preload monkey patching — `src/application.js`; legacy preloads are compatibility shells only.
- [x] 04. `free_claim` is a valid subscription source and is handled by entitlement precedence — migration 036 and `src/entitlements/subscription-state.js`.
- [x] 05. Direct customer checkout enforces plan audience server-side — `src/payments/lifecycle.js`.
- [x] 06. Free/trial claims enforce direct-customer audience server-side — `src/payments/lifecycle.js`.
- [x] 07. Resuming a reseller customer reacquires the reseller lock and re-checks tier capacity — `src/resellers/monthly.js`.
- [x] 08. Access suspension is composable rather than a single destructive reason string — `customer_access_holds`, `src/entitlements/access-holds.js`.
- [x] 09. Reseller recurring checkout is protected by local checkout intents and live-subscription uniqueness — migration 036, `src/payments/checkout-intents.js`, reseller billing.
- [x] 10. Direct recurring checkout cannot silently create overlapping live provider subscriptions — `src/entitlements/subscription-state.js`, `src/payments/lifecycle.js`, checkout intents.
- [x] 11. One canonical effective-subscription resolver defines entitlement precedence — `src/entitlements/subscription-state.js`.
- [x] 12. Reseller manual sales cannot rewrite a live Stripe/PayPal subscription in place — `src/resellers/monthly.js` and source-rewrite guards.
- [x] 13. Legacy credit extensions cannot rewrite a live provider subscription — `src/subscriptions.js` safety facade.
- [x] 14. Hard-coded public customer import inventory is removed — `import_users.js` is absent.
- [x] 15. README describes the current PostgreSQL/Docker/monthly-reseller architecture and supported startup path — `README.md`.
- [x] 16. Obsolete JSON-era expiry mutation script is removed — `check-expired.js` is absent.
- [x] 17. Reseller estate reconciliation mutates/audits only on state transitions — `src/resellers/monthly.js`.
- [x] 18. Reseller analytics uses timestamp-derived playback duration and the stale duration-column implementation is gone — `src/resellers/monthly.js`.
- [x] 19. Reseller MRR/ARR never adds unlike currencies together — `src/platform/admin-reseller-tiers.js`, `src/platform/admin-commerce.js`.
- [x] 20. Reseller downstream revenue is constrained to the reseller ledger currency and reported separately from CAPTaINFiN revenue — reseller settings/ledger/analytics.
- [x] 21. Reseller-owned Jellyfin access is classified as `owner_access`, not a £0 customer sale — `src/resellers/monthly.js`.
- [x] 22. Reseller sales corrections are append-only refunds/voids/adjustments — migration 041, `src/resellers/ledger.js`, `src/platform/reseller-ledger.js`.
- [x] 23. Reseller ledger currency is browser-configurable globally and per reseller — reseller settings and reseller 360 controls.
- [x] 24. Downstream reseller payment-method labels are browser-configurable — `src/resellers/settings.js`, reseller settings UI.
- [x] 25. Reseller tier commercial/capacity/grace terms are snapshotted into subscriptions for grandfathering — migration 036 and monthly subscription service.
- [x] 26. Stripe/PayPal reseller tier mappings can be verified against active monthly recurrence, amount and currency — `src/payments/reseller-billing-v2-core.js`, tier admin UI.
- [x] 27. Reseller tier changes support immediate Stripe upgrades, period-end downgrades, PayPal reauthorization and capacity blocking — `src/platform/reseller-tier-changes.js`, reseller billing/automation.
- [x] 28. Reseller dunning supports tier grace, audited manual grace and estate suspension timing — migration 043, `src/resellers/dunning.js`, `src/platform/admin-reseller-dunning.js`.
- [x] 29. Refunds, failed renewals, disputes and chargebacks are distinct payment incidents with selectable access policy — migration 045, `src/payments/incidents.js`, provider webhooks, Admin Commerce.
- [x] 30. PayPal return activation is bound to a single-use local checkout intent/state and owner — checkout intents and payment-return/reseller billing routes.
- [x] 31. Authenticated state-changing customer/reseller/admin flows use CSRF guards; canonical customer mutation guard remains enabled — auth CSRF + platform routers.
- [x] 32. People → Resellers and Reseller 360 are monthly-entitlement first, with credits labelled legacy — `src/platform/admin-resellers*.js`.
- [x] 33. Reseller portal login, estate suspension and renewal control are separate administrator actions — reseller 360/admin controls.
- [x] 34. Admin reseller preview reflects monthly tier, seats, revenue, streams and parent billing rather than credit-first UI — `src/platform/admin-preview.js`.
- [x] 35. Admin-created resellers use one-time activation links instead of administrator-visible passwords — `src/auth/account-activation.js`, reseller admin flow.
- [x] 36. Admin-created direct customers use one-time activation links instead of administrator-visible passwords — `src/platform/admin-actions.js`.
- [x] 37. 2FA is a sign-in factor; routine plan/server/settings/branding forms do not ask for fake repeated TOTP/recovery codes — auth service plus cleaned admin UIs.
- [x] 38. General reseller defaults are monthly-model defaults: tier, ledger currency, payment methods, owner account and reseller 2FA policy — `/admin/settings/resellers`.
- [x] 39. Each reseller tier can explicitly select downstream customer/owner/trial plans — `reseller_tier_plan_rules`, tier administration.
- [x] 40. A reseller seat is defined and displayed as one active customer entitlement; owner access consumes one when enabled — reseller service/portal/tier UI.
- [x] 41. Configuration Transfer V2 carries request quotas, reseller tiers/rules, non-secret mappings, automation and commercial policy while retaining V1 import compatibility — configuration transfer V2 + facade.
- [x] 42. Setup Readiness distinguishes direct commerce readiness from reseller commerce readiness — `src/platform/setup-readiness.js`.
- [x] 43. Settings/readiness use the same provider/request/email status services as runtime rather than stale duplicated checks — Settings + Setup Readiness.
- [x] 44. `JELLYFIN_ALLOWED_HOSTS` is no longer required or presented by current server/readiness configuration — server admin, readiness, env/docs regression guards.
- [x] 45. Production readiness inspects browser-managed integrations rather than relying on obsolete provider env variables — readiness service/script.
- [x] 46. Scheduled mutation work runs in a dedicated `automation-worker`, not duplicate web-process timers — `scripts/automation-worker.js`, Compose.
- [x] 47. Automation jobs have browser-managed enable/interval controls with bounded schedules — `/admin/automation`.
- [x] 48. Every automation job exposes last run/success/error/duration/processed/next run and Run now — automation job-health/admin UI.
- [x] 49. Customer login/reset throttling is PostgreSQL-backed and survives restart/replicas — `src/security/customer-rate-limit.js`.
- [x] 50. CI instantiates the real production application composition and checks critical mounted routes — `scripts/assembled-app-smoke.js`.
- [x] 51. CI detects duplicate/shadowed critical Express routes recursively — assembled-app smoke.
- [x] 52. JavaScript syntax checking is recursive instead of a hand-maintained file list — `scripts/check-js-syntax.js`.
- [x] 53. Dead duplicate runtime modules/views are removed or reduced to explicit compatibility facades — old reseller routers/dashboard, admin-business and JSON scripts removed.
- [x] 54. `secure-start.js`, `app.js` and preload files no longer own business routes; the normal application/middleware stack does — canonical application composition.
- [x] 55. Runtime site branding is read from the runtime-settings service; database identity is not written back into `process.env.SITE_NAME` — `src/platform/runtime-settings.js`.
- [x] 56. Logo/favicon binary assets are PostgreSQL-backed and legacy filesystem branding is auto-imported once — migration 040, `src/platform/branding.js`.
- [x] 57. The unused external `captainfin_proxy` Compose network declaration is removed — `docker-compose.yml`.
- [x] 58. Reseller lifecycle notifications cover activation/cancellation, payment failure, grace, scheduled suspension, estate suspend/restore, tier changes, capacity and 7/3/1-day child expiry — migration 039, notification observer.
- [x] 59. Notification-channel UX is consistent with implemented providers: Email and Telegram are exposed; unsupported WhatsApp controls/config claims are removed — Settings/env/docs regression guard.
- [x] 60. Resellers receive 80/90/100% capacity warnings and see capacity visually on their dashboard — notification observer + reseller portal.
- [x] 61. Reseller dashboard reports downstream revenue and estimated gross margin separately from CAPTaINFiN revenue — reseller analytics portal.
- [x] 62. Admin Commerce reports direct/reseller MRR, ARR, activation/churn and lifecycle/payment incident state — `src/platform/admin-commerce.js`.
- [x] 63. Admin Events provides one searchable timeline for audit, security, payments/incidents, provisioning and email — `src/platform/admin-events.js`.
- [x] 64. Admin global search resolves customers, resellers, Jellyfin identities, servers and provider references to management pages — `src/platform/admin-search.js`.
- [x] 65. Configuration Health reports plan/server/payment/request/reseller dependency problems and links to the affected configuration — `src/platform/admin-configuration-health.js`.
- [x] 66. Risky edits show impact and require deliberate confirmation where they can affect live plan/tier/server estates — plan/tier/server admin UIs.
- [x] 67. Direct customers use controlled recurring plan changes plus explicit Stop/Resume renewal controls rather than overlapping recurring subscriptions — customer plan-change service, customer subscription actions and portal.
- [x] 68. Customer portal exposes subscription/payment/provider/plan-change history — `/account/history`.
- [x] 69. Admin can select trial/free eligibility, paid-to-free eligibility and automatic free downgrade policy — Admin Commerce + lifecycle/provisioning.
- [x] 70. README and ROADMAP are aligned with the current architecture/features rather than the JSON/credit-first legacy product — `README.md`, `ROADMAP.md`.
- [x] 71. Migration 016 is explicitly reserved and the stale PR #59 policy-drift feature is reimplemented on current main as migration 042, avoiding numbering conflict — reserved migration + drift service/router/worker/smoke.

## Completion rule

The PR is not considered ready merely because all 71 boxes are checked. It must also pass the full migration chain, assembled-app route contract, platform-coherence static/DB checks, policy-drift smoke and the repository's existing relevant workflows on the exact final head.
