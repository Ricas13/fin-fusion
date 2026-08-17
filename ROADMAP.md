# CAPTAiNFiN / Steam Fusion Roadmap

This roadmap describes the current PostgreSQL CAPTAiNFiN platform, not the original JSON-file Steam Fusion application.

## Product principles

- A clean installation must work with zero Jellyfin servers, plans, customers, resellers and payment providers.
- Existing production data must survive upgrades; migrations are additive and checksum-tracked.
- Business configuration belongs in browser-managed database settings where practical; environment variables are primarily infrastructure/secrets compatibility inputs.
- Customer, reseller and Jellyfin identities are separate concepts.
- One effective entitlement controls customer access; independent holds must compose safely rather than overwrite each other.
- Provider-managed billing must never be silently converted into manual access.
- Scheduled mutation work must be singleton-safe and observable.
- White-label identity belongs to the installation and should remain future-tenant-scope friendly.

## Foundation — implemented

- [x] PostgreSQL business model and migrations.
- [x] PostgreSQL sessions and persistent authentication throttling.
- [x] Browser first-run setup and unattended admin bootstrap.
- [x] Optional/enforceable staff 2FA with recovery codes.
- [x] Purpose-specific encryption keys and encrypted application secrets.
- [x] Docker/Compose production stack with one-shot migrations.
- [x] Encrypted PostgreSQL backup/restore tooling.
- [x] Structured audit/security event persistence.
- [x] Safe configuration export/import.
- [x] Explicit application composition replacing route/preload shadowing.
- [x] Dedicated automation worker with advisory-lock singleton execution and job health.

## Jellyfin fleet — implemented

- [x] Multiple browser-managed Jellyfin servers.
- [x] Encrypted API keys and testable connections.
- [x] Server health and cached fleet metrics.
- [x] Total Jellyfin users and managed/unmanaged live streams.
- [x] Library synchronisation and plan library policy.
- [x] Plan server eligibility and fleet-aware placement.
- [x] Real-capacity placement using actual Jellyfin population/live load.
- [x] Sticky primary account placement.
- [x] Resilient provisioning/retry/control centre.
- [x] Controlled customer migration between servers.
- [x] Import/link existing Jellyfin users safely without default mutation.
- [x] Stream policy/activity worker and managed-account enforcement isolation.

### Fleet follow-up

- [ ] Rebase and complete the separate Policy Drift work (historical PR #59) against the current schema/migration sequence.
- [ ] Optional location/latency-aware placement rules.
- [ ] Optional per-server maintenance/drain mode with controlled migration planning.

## Direct customer commerce — implemented

- [x] Configurable customer plans and audiences.
- [x] Trial/free/one-time/recurring terms.
- [x] Concurrent stream/download/transcoding/live-TV policies.
- [x] Plan library controls.
- [x] Per-plan Seerr/Overseerr movie/TV request quotas.
- [x] Stripe one-time and recurring checkout.
- [x] PayPal one-time and recurring checkout.
- [x] Browser-managed encrypted provider credentials and test connection.
- [x] Per-plan provider/checkout-mode mappings.
- [x] Discount codes and referrals.
- [x] Provider webhook verification/idempotency.
- [x] Recurring subscription verification/control centre.
- [x] Stop/resume renewal where provider semantics allow it.
- [x] Billing network/API failure does not revoke local access.
- [x] Local checkout intents prevent duplicate concurrent checkout creation.
- [x] Server-side direct/reseller plan audience enforcement.
- [x] Controlled Stripe upgrade/downgrade transitions instead of overlapping recurring subscriptions.
- [x] PayPal plan-change flow preserves paid-through access and requires replacement authorisation.
- [x] Explicit free/trial eligibility policy.
- [x] Customer subscription/payment history.

### Direct commerce follow-up

- [ ] Rich invoice/receipt links where providers expose stable customer-facing URLs.
- [ ] Configurable refund/dispute access policy beyond the conservative preserve-paid-through default.
- [ ] Additional payment providers only when they can meet the same verification/idempotency model.

## Customer identity/self-service — implemented

- [x] Separate portal/Jellyfin identity.
- [x] Public/invite-only registration.
- [x] Email verification.
- [x] Forgot/reset password.
- [x] One-time admin-created customer activation links.
- [x] Imported-customer claim links.
- [x] Customer account portal.
- [x] Jellyfin password change.
- [x] Request-site password management.
- [x] Library visibility self-service.
- [x] Plan comparison/change flow.
- [x] Subscription/payment history.

### Customer follow-up

- [ ] Household/linked portal identities where a single billing owner intentionally controls multiple people.
- [ ] Optional customer notification preferences.
- [ ] Optional customer session/device management UI equivalent to staff security UI.

## Monthly reseller platform — implemented

- [x] Monthly reseller tiers.
- [x] Recurring Stripe/PayPal parent billing.
- [x] Manual reseller entitlement for migration/complimentary access.
- [x] Active-customer entitlement limits (seat = one active customer entitlement).
- [x] Optional reseller-owned Jellyfin account consuming one entitlement.
- [x] Parent billing failure/expiry suspends child estate while preserving history.
- [x] Grace periods.
- [x] Independent portal-login, estate-hold, renewal and customer-hold controls.
- [x] Atomic capacity enforcement on activation/resume.
- [x] Tier commercial-term snapshots/grandfathering.
- [x] Tier-specific downstream customer-plan catalogue.
- [x] Provider mapping validation against remote recurrence/amount/currency.
- [x] Stripe immediate tier changes/proration and renewal resume.
- [x] Append-only reseller-reported sales ledger semantics.
- [x] Configurable reseller ledger currency and payment methods.
- [x] Revenue/watch-time/live-stream/seat-utilisation dashboard.
- [x] Seat-use warnings and profitability estimate.
- [x] Reseller self-service password/2FA/recovery/session controls.
- [x] One-time reseller activation links; admins do not know reseller passwords.
- [x] Legacy credits retained only as compatibility/history.

### Reseller follow-up

- [ ] Automated upgrade recommendations/notifications based on sustained utilisation.
- [ ] Provider-native scheduled downgrade where provider APIs make it unambiguous.
- [ ] Optional reseller-specific branding/white-label portal scope.
- [ ] Optional reseller tax/VAT invoice metadata if CAPTAiNFiN becomes the merchant of record for reseller fees.

## Requests — implemented

- [x] Central Seerr/Overseerr browser-managed integration.
- [x] One request account per CAPTAiNFiN customer.
- [x] Existing account link-by-email without password reset.
- [x] Deterministic placeholder email for genuinely emailless managed users.
- [x] Per-plan movie/TV rolling quotas.
- [x] Payment lapse sets request permissions to zero without deleting request history.
- [x] Renewal restores remembered permissions.
- [x] Customer request-site password management.
- [x] Background reconciliation/retry.

### Requests follow-up

- [ ] Optional additional request-service adapters only where their identity/quota model can be normalised cleanly.
- [ ] Customer-facing request activity/history embedded directly in CAPTAiNFiN if required.

## Notifications — implemented

- [x] Telegram operational notifications.
- [x] Browser-managed SMTP.
- [x] Encrypted transactional outbox.
- [x] Retry/failure history.
- [x] Verification/reset/activation email delivery.
- [x] Configurable event channel preferences for implemented channels.
- [x] Reseller billing/estate lifecycle event catalogue.

### Notifications follow-up

- [ ] User-level preferences/templates.
- [ ] Discord delivery provider.
- [ ] WhatsApp only after a real provider adapter, encrypted credentials, delivery history and retry model are implemented; do not present environment placeholders as a finished channel.
- [ ] Broadcast/mass-contact tooling with explicit recipient scopes and opt-out controls.

## Administration/operations — implemented

- [x] Modern admin navigation/shell.
- [x] Customer 360 and reseller 360.
- [x] Server/library dashboards.
- [x] Provisioning control centre.
- [x] Billing lifecycle control centre.
- [x] Setup readiness.
- [x] Configuration Health dependency/impact warnings.
- [x] Global search across customer/reseller/server/provider identifiers.
- [x] Unified audit/security/payment/provisioning/email event timeline.
- [x] Direct/reseller recurring-commerce reporting with currencies separated.
- [x] Automation job health/scheduling/run-now.
- [x] Safe admin portal previews.
- [x] Bulk customer operations/job handling.

### Administration follow-up

- [ ] Fine-grained staff RBAC (support/read-only/billing/operator roles).
- [ ] Approval workflow for especially destructive bulk operations.
- [ ] Custom FAQ/content management.
- [ ] Richer saved filters/report exports.

## Storefront/branding — implemented

- [x] Browser-managed site name/logo/favicon/accent/appearance settings.
- [x] Premium responsive storefront.
- [x] Dynamic direct plan pricing/savings/proof points.
- [x] Closed/open registration-aware CTAs.
- [x] Reseller tier marketing section rendered through the canonical storefront path.
- [x] No third-party/copyrighted poster dependency.
- [x] Clean zero-plan state.

### Storefront follow-up

- [ ] Richer browser-managed section ordering/content blocks.
- [ ] Optional custom domain helper/validation UI.
- [ ] PWA/offline shell if there is a real customer use case.

## Portability / SaaS readiness — implemented foundation

- [x] Clean install starts with zero business objects.
- [x] No hard requirement for Jellyfin/payment providers at app startup.
- [x] Configuration transfer V2 covers plans/quotas/reseller tiers/rules/non-secret mappings/automation.
- [x] Runtime branding reads the configuration service instead of mutating `process.env`.
- [x] Business objects use UUID identities suitable for future tenant scoping.

### Portability follow-up

- [ ] Shared/object storage for branding assets before horizontal multi-host deployment.
- [ ] Introduce explicit workspace/tenant IDs only when multi-tenant hosting becomes an actual product requirement.
- [ ] Distributed cache only if performance measurements justify it.

## Test/quality direction

- [x] Recursive JavaScript syntax checking.
- [x] Feature smoke/integration workflows.
- [x] Blank-install workflow.
- [x] Provisioning/billing/reseller integration coverage.
- [x] Production readiness audit using current browser-managed integrations and canonical placement rules.
- [ ] Keep an exact assembled-application HTTP route contract test mandatory as routing evolves.
- [ ] Gradually add lint/type checking without obscuring product-level integration tests.

## Cutover definition

CAPTAiNFiN is ready to replace a third-party manager for a deployment when:

1. All required Jellyfin servers/libraries/plans are represented and healthy.
2. Existing users are imported/linked with identities verified.
3. Direct and/or reseller billing mappings are tested.
4. Automation worker health is green.
5. Provisioning/billing queues contain no unexplained failures.
6. Transactional email/required notifications work.
7. Configuration Health has no unresolved critical dependency warning.
8. A current encrypted database backup and tested restore procedure exist.
9. Production readiness returns no critical failures.
10. Shadow observation confirms subscriptions, Jellyfin access and request permissions match the intended commercial policy before the legacy manager is retired.
