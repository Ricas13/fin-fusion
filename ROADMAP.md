# Steam Fusion / CAPTaINFiN Roadmap

This fork keeps the useful Steam Fusion reseller workflow while turning it into a production-grade, self-hosted multi-server platform.

**Product target:** feature parity with Streams Manager for the Jellyfin workflows required to retire the existing Streams Manager instance, while retaining and expanding Steam Fusion's reseller functionality.

See [`STREAMS_MANAGER_PARITY.md`](STREAMS_MANAGER_PARITY.md) for the canonical parity checklist and cutover definition. If this roadmap and the parity document differ, the parity document defines the product feature target.

## Phase 1 — Security and production foundation

- [x] Remove usable `admin/admin123` bootstrap
- [x] Enforce environment-backed session secret
- [x] Secure proxy-aware session cookies
- [x] Remove plaintext Jellyfin client passwords at rest
- [x] Redact secrets from backups and normal API/template responses
- [x] Replace legacy generated-password randomness with cryptographic randomness
- [x] Add login throttling
- [x] Add baseline security headers and cross-site request protection
- [x] Add CI syntax/dependency checks
- [ ] Refactor the security bootstrap into the core application modules
- [ ] Add full automated route/security tests

## Phase 2 — Durable platform architecture

- [x] PostgreSQL data model and migrations
- [x] Persistent PostgreSQL-backed session storage
- [x] Docker image and production Compose stack
- [x] Structured audit-log schema for admin/reseller/security actions
- [x] Transaction-safe reseller credit/subscription service foundation
- [x] Encrypted secret-storage primitive
- [x] Provider-neutral payment-event/idempotency schema
- [x] Legacy JSON migration/import path
- [ ] Backup/restore tooling with encryption support
- [ ] Persistent distributed rate-limit storage
- [ ] Background job queue / failed-job handling

## Phase 3 — Multi-server support

- [x] Multi-server database/registry foundation
- [ ] Manage multiple Jellyfin servers from the admin UI
- [ ] Per-server URL, encrypted API key and health status
- [ ] Assign clients/resellers/plans to a server or server pool
- [ ] Premium and Free server classes
- [ ] Server capacity/health/location-aware account placement
- [x] Controlled client migration between servers
- [ ] Per-server policy templates for streams, downloads and transcoding
- [ ] Continuous user/server/library reconciliation

## Phase 3U — Clean install / white-label / SaaS readiness

This is a cross-cutting product rule rather than a final migration phase: new work must remain valid when there are zero servers, zero plans, zero customers, zero resellers and zero payment providers.

- [x] Genuinely fresh PostgreSQL database starts with zero business objects
- [x] Jellyfin is optional at application startup
- [x] Existing installations are protected from fresh-install cleanup
- [x] Environment-based bootstrap creates the first native administrator when required
- [x] Admin Setup checklist and feature-readiness view
- [x] Empty admin dashboard remains usable and guides configuration
- [x] Storefront disabled by default on clean installs
- [x] Public registration disabled by default on clean installs
- [x] Referral rewards disabled by default on clean installs
- [x] Payment and notification providers remain optional
- [x] Automated blank-database test reaches a working administrator dashboard
- [x] Browser-based first-run administrator creation and permanent setup lockout
- [ ] Remove remaining legacy Premium/Free business assumptions where they are not intrinsic configuration
- [x] Safe configuration export/import
- [ ] Review new data models for future workspace/tenant scoping without implementing full multi-tenancy

## Phase 4 — Plans and subscription lifecycle

- [x] Database-backed plan/subscription models
- [x] Preserve historical CAPTaINFiN trial/monthly/6-month/yearly plans on upgrades while clean installs start empty
- [ ] Configurable plans in admin UI
- [ ] Plan library groups
- [ ] Trial, one-time and recurring terms
- [ ] Hour-level duration support
- [ ] Per-plan concurrent-stream allowance
- [ ] Per-plan download/transcoding/4K policy
- [ ] Add-on products
- [ ] Inactive/grandfathered plans
- [ ] Grace periods and renewal reminders
- [ ] Reseller pricing/credit costs per plan
- [ ] Idempotent expiry/reactivation jobs
- [ ] Automatic Jellyfin provisioning and policy reconciliation

## Phase 5 — Streams Manager replacement payments

- [x] Provider-neutral payment abstraction/schema
- [ ] Stripe Billing + Checkout Sessions
- [ ] Stripe Customer Portal
- [ ] Stripe one-time purchases
- [ ] PayPal subscriptions
- [ ] PayPal one-time payments
- [ ] Webhook verification
- [ ] Idempotent payment event processing
- [ ] Payment-to-subscription reconciliation
- [ ] Refund/cancellation handling
- [ ] Failed payment / grace-period handling
- [ ] Multiple payment methods per plan
- [ ] Per-plan provider pricing/mapping
- [ ] Discounts/promo codes
- [ ] Referral credits / referral links

## Phase 6 — Customer lifecycle and bulk operations

- [ ] Customer self-registration
- [ ] Email verification
- [ ] Password reset
- [ ] Customer profile fields
- [ ] Admin create/edit/delete customer
- [ ] Bulk customer import
- [ ] Bulk enable/disable/delete
- [ ] Bulk plan change
- [ ] Bulk server migration
- [ ] Bulk email/message
- [ ] Customer tags/segments
- [ ] Customer notes
- [ ] Expiring/expired customer views
- [ ] Customer activity / last seen

## Phase 7 — Reseller workflows

- [x] Existing Steam Fusion reseller dashboard retained
- [x] Existing credit and trial-credit concept retained
- [ ] Reseller account management in PostgreSQL
- [ ] Reseller-created customer provisioning through multi-server layer
- [ ] Per-reseller server/pool constraints
- [ ] Per-reseller plan catalogue
- [ ] Trial-plan configuration
- [ ] Configurable trial-credit return policy
- [ ] Wholesale/reseller pricing per plan
- [ ] Reseller payment/credit purchases
- [ ] Reseller commissions / revenue share
- [ ] Reseller branding options
- [ ] Reseller API keys
- [ ] Reseller audit trail

## Phase 8 — Activity, policy enforcement and reporting

- [ ] Real-time stream visibility
- [ ] Stream-policy engine
- [ ] Concurrent stream enforcement
- [ ] Download policy/enforcement
- [ ] Transcoding policy enforcement
- [ ] 4K policy enforcement
- [ ] Device/session limits
- [ ] Bandwidth and playback reporting
- [ ] Direct-play/transcode reporting
- [ ] Reseller sales/renewal/credit reports
- [ ] CSV export
- [ ] Admin dashboard trends and revenue projections

## Phase 9 — Libraries and media integrations

- [ ] Library import/synchronization
- [ ] Library groups/types
- [ ] Hide libraries from sharing
- [ ] Attach multiple library groups to plans
- [ ] Overseerr integration
- [ ] Ombi integration
- [ ] Petio integration
- [ ] Discord role synchronization
- [ ] Radarr/Sonarr-native request workflow
- [ ] User-request media refresh/scan
- [ ] Admin library/folder refresh
- [ ] Subtitle upload where safe/appropriate

## Phase 10 — Content requests

The original project already contains a basic content-request workflow. The fork will expand it rather than rebuilding it from scratch.

- [x] Basic reseller request and admin response
- [ ] Customer request portal
- [ ] Request type/status/priority
- [ ] Duplicate detection
- [ ] Search-before-request flow
- [ ] Per-reseller/customer request limits
- [ ] Automatic status updates
- [ ] Notification on fulfilment

## Phase 11 — Admin operations and RBAC

- [ ] Full customer detail page
- [ ] Unmatched payments panel
- [ ] Events/errors panel
- [ ] Pending invites panel
- [ ] Mass contact
- [ ] Custom FAQ management
- [ ] Custom administrator roles
- [ ] Support/read-only/operator roles
- [ ] Privileged-role 2FA enforcement
- [ ] Per-action audit history

## Phase 12 — White label / CAPTAiNFiN product layer

- [ ] CAPTAiNFiN branding/theme
- [ ] Custom domain
- [ ] Logo and wallpaper
- [ ] Home/pricing/subscription/library-statistics custom content
- [ ] Custom theme
- [ ] Custom FAQ
- [ ] Responsive/PWA customer portal
- [ ] Premium/Free plan mapping
- [ ] Reseller portal onboarding
- [ ] Admin operations dashboard
- [ ] Import existing Jellyfin users safely
- [ ] Import Streams Manager customer/subscription data
- [ ] Production migration/runbook
- [ ] Shadow-mode parity verification before cutover

## Phase 13 — Reseller enhancements

- [x] Resellers, regular credits and trial credits inherited from Steam Fusion
- [x] Reseller-owned customers
- [ ] Reseller-specific plan catalogue
- [ ] Wholesale price/credit cost per plan
- [ ] Stripe/PayPal reseller credit purchase
- [ ] Reseller sales/renewal analytics
- [ ] Reseller notification preferences
- [ ] Optional reseller white-label branding
