# CAPTAiNFiN / Steam Fusion Roadmap

This roadmap describes the current PostgreSQL CAPTAiNFiN platform. Historical phase notes and old migrations may describe earlier product models; they are not the source of truth for current runtime behavior.

## Product principles

- Clean installation must work with zero Jellyfin servers, customers, resellers and payment providers.
- Existing production data must survive upgrades; applied migrations are immutable and checksum-tracked.
- Business configuration belongs in browser-managed database settings where practical.
- Customer, reseller, portal and Jellyfin identities are separate concepts.
- Access restrictions must compose safely through independent holds.
- Provider-managed billing must never be silently converted into manual access.
- Scheduled mutation work must be singleton-safe, observable and recoverable.
- CAPTAiNFiN should only model commercial activity it actually owns.

## Foundation — implemented

- [x] PostgreSQL business model, migrations and sessions.
- [x] Persistent authentication throttling and first-run setup.
- [x] Optional/enforceable staff/reseller 2FA with recovery codes.
- [x] Purpose-specific encryption keys and encrypted application secrets.
- [x] Docker/Compose production stack with one-shot migrations.
- [x] Encrypted PostgreSQL backup/restore tooling.
- [x] Audit/security event persistence.
- [x] Safe non-secret configuration export/import.
- [x] Explicit application composition and route-ownership checks.
- [x] Dedicated automation worker with advisory-lock singleton execution.

## Jellyfin fleet — implemented

- [x] Multiple browser-managed Jellyfin servers.
- [x] Encrypted API keys and connection testing.
- [x] Server health, cached metrics and live stream visibility.
- [x] Library synchronisation and plan library policy.
- [x] Server eligibility, fleet-aware placement and sticky primary placement.
- [x] Provisioning/retry/control centre.
- [x] Controlled customer migration between servers.
- [x] Safe import/linking of existing Jellyfin users.
- [x] Stream-policy/activity worker and managed-account enforcement isolation.

### Fleet follow-up

- [ ] Complete policy-drift remediation UX against the current schema.
- [ ] Optional location/latency-aware placement.
- [ ] Optional server maintenance/drain mode with migration planning.

## Direct customer commerce — implemented

- [x] Configurable customer plans and service types.
- [x] Free, trial, one-time and recurring terms.
- [x] Concurrent stream/download/transcoding/Live TV/library policies.
- [x] Per-plan request quotas.
- [x] Stripe and PayPal checkout.
- [x] Browser-managed encrypted provider credentials.
- [x] Multi-currency pricing and price-scoped provider mappings.
- [x] Discount codes and referrals.
- [x] Provider webhook verification/idempotency.
- [x] Controlled recurring plan transitions.
- [x] Customer subscription/payment history.
- [x] Permanent canonical Free Access tier with zero-capacity/full state.

### Direct commerce follow-up

- [ ] Rich provider invoice/receipt links where stable customer-facing URLs exist.
- [ ] Configurable refund/dispute access policy.
- [ ] Additional providers only when they meet the same verification/idempotency contract.

## Customer identity/self-service — implemented

- [x] Separate portal/Jellyfin identity.
- [x] Registration, invitation and activation flows.
- [x] Email verification and password reset.
- [x] Imported-customer claim links.
- [x] Customer portal and Jellyfin/request-service password management.
- [x] Library visibility self-service.
- [x] Plan comparison/change flow.

### Customer follow-up

- [ ] Household/linked portal identities where one billing owner intentionally controls multiple people.
- [ ] Richer customer notification preferences.
- [ ] Optional customer session/device management.

## Monthly reseller platform — implemented

The reseller model is monthly managed-seat licensing, not downstream resale accounting.

- [x] Monthly reseller plans with managed Jellyfin user limits.
- [x] Multiple configured currency/price variants per reseller plan.
- [x] Price-scoped Stripe/PayPal recurring mappings.
- [x] Manual reseller entitlement for migration/complimentary access.
- [x] One managed Jellyfin user consumes one seat.
- [x] Suspension keeps a seat occupied; deletion releases it.
- [x] Managed users inherit Jellyfin policy from the reseller plan.
- [x] Plan-level streams, downloads, transcoding, Live TV, remote access, 4K, placement and library rules.
- [x] Parent billing expiry/grace controls the managed Jellyfin estate.
- [x] Atomic managed-seat capacity enforcement.
- [x] Commercial-term snapshots/grandfathering.
- [x] Capacity-safe plan changes/downgrades.
- [x] Reseller self-service password/2FA/recovery/session controls.
- [x] One-time reseller activation links.
- [x] Legacy reseller sales/credit structures excluded from active runtime and retained only where migration/audit compatibility requires them.

The reseller's own customer billing, pricing, invoicing and CRM remain outside CAPTAiNFiN.

### Reseller follow-up

- [ ] Automated upgrade recommendations based on sustained managed-seat utilisation.
- [ ] Provider-native scheduled downgrade where APIs make the behavior unambiguous.
- [ ] Optional reseller-specific branding/white-label scope.
- [ ] Optional tax/VAT invoice metadata for the **reseller subscription fee** if CAPTAiNFiN becomes merchant of record for it.

## Requests — implemented

- [x] Central Seerr/Overseerr integration.
- [x] One request account per CAPTAiNFiN customer.
- [x] Existing account link-by-email without password reset.
- [x] Deterministic placeholder email for genuinely emailless managed users.
- [x] Per-plan movie/TV rolling quotas.
- [x] Billing/access lifecycle reconciliation.
- [x] Customer request-site password management.

## Notifications — implemented foundation

- [x] Transactional email/outbox with retry history.
- [x] Telegram operational delivery.
- [x] Browser-managed channel/infrastructure configuration.
- [x] Event catalogue and channel preferences for implemented channels.
- [x] Lifecycle notification events.

### Notifications follow-up

- [ ] Continue separating global channel/event capability from per-admin and per-customer preferences.
- [ ] Discord/WhatsApp only through real configured adapters with encrypted credentials and delivery history.
- [ ] Broadcast tooling with explicit recipient scopes and opt-out controls.

## Administration/operations — implemented

- [x] Admin navigation/shell.
- [x] Customer 360 and reseller 360.
- [x] Server/library dashboards.
- [x] Provisioning and billing control centres.
- [x] Setup/configuration health.
- [x] Global search and unified operational timelines.
- [x] Recurring-commerce reporting with currencies separated.
- [x] Automation job health/scheduling/run-now.
- [x] Safe admin portal previews.
- [x] Bulk customer operations.
- [x] Consistent customer/reseller/Stremio plan-setup information architecture.
- [x] Drag/drop storefront ordering.

### Administration follow-up

- [ ] Fine-grained staff RBAC.
- [ ] Approval workflow for especially destructive bulk operations.
- [ ] Custom FAQ/content management.
- [ ] Richer saved filters/report exports.

## Storefront/branding — implemented

- [x] Browser-managed site name/logo/favicon/accent/appearance.
- [x] Responsive storefront.
- [x] Dynamic plan pricing/savings/proof points.
- [x] Registration-aware CTAs.
- [x] Reseller plan marketing through the canonical storefront.
- [x] Permanent featured Free Access panel, including full/unavailable state.
- [x] Persisted admin-controlled plan ordering.
- [x] Clean zero-plan state.

## Portability / SaaS-readiness foundation — implemented

- [x] Clean install starts with zero business objects except protected system defaults such as Free Access.
- [x] No hard requirement for Jellyfin/payment providers at app startup.
- [x] Configuration transfer covers current plan/pricing/reseller-policy/mapping/automation configuration.
- [x] Runtime branding reads configuration rather than mutating `process.env`.
- [x] Business objects use UUID identities suitable for future tenant scoping.

### Portability follow-up

- [ ] Shared/object storage for branding assets before horizontal multi-host deployment.
- [ ] Explicit workspace/tenant IDs only when multi-tenant hosting becomes a real requirement.
- [ ] Distributed cache only if measurements justify it.

## Test/quality direction

- [x] Recursive JavaScript syntax checking.
- [x] Feature smoke/integration workflows.
- [x] Blank-install and upgrade-path workflows.
- [x] Provisioning/billing/reseller integration coverage.
- [x] Assembled-application route-ownership checks.
- [x] Browser regression coverage.
- [x] Adversarial concurrency checks.
- [x] CodeQL security analysis.
- [x] Production-readiness audit.
- [ ] Gradually add lint/type checking where it improves signal without replacing product-level integration tests.

## Cutover definition

CAPTAiNFiN is ready to replace a third-party manager for a deployment when:

1. Required Jellyfin servers/libraries/plans are represented and healthy.
2. Existing users are imported/linked with identities verified.
3. Direct and/or reseller billing mappings are tested.
4. Automation worker health is green.
5. Provisioning/billing queues contain no unexplained failures.
6. Required transactional notifications work.
7. Configuration Health has no unresolved critical dependency warning.
8. A current encrypted database backup and tested restore procedure exist.
9. Production readiness returns no critical failures.
10. Shadow observation confirms subscriptions, Jellyfin access and request permissions match intended policy before any legacy manager is retired.
