# Steam Fusion / CAPTAiNFiN Roadmap

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
- [ ] Controlled client migration between servers
- [ ] Per-server policy templates for streams, downloads and transcoding
- [ ] Continuous user/server/library reconciliation

## Phase 4 — Plans and subscription lifecycle

- [x] Database-backed plan/subscription models
- [x] Seed current trial/monthly/6-month/yearly CAPTAiNFiN plans
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
- [ ] PayPal integration
- [ ] Square integration
- [ ] SumUp integration
- [ ] Plisio/crypto integration
- [ ] Per-gateway enable/disable
- [ ] Webhook signature verification and idempotency
- [ ] One-time/pay-as-you-go purchases
- [ ] Recurring subscriptions
- [ ] Transaction synchronization/reconciliation
- [ ] Unmatched-payment queue and manual matching
- [ ] Manual payment entry
- [ ] Automatic reseller credit purchases
- [ ] Automatic customer subscription activation/extension
- [ ] Refund and chargeback state handling
- [ ] Discount codes

## Phase 6 — Registration, self-service and identity

- [ ] Separate site-login identity from Jellyfin identity
- [ ] Public/invite-only registration
- [ ] Email verification
- [ ] Password reset
- [ ] Customer profile/account portal
- [ ] Subscription/payment history
- [ ] Change/extend subscription
- [ ] Pending invites and bulk invitations
- [ ] Referral-code registration
- [ ] Linked/household users
- [ ] Merge/replacement user workflow
- [ ] TOTP two-factor authentication
- [ ] Recovery codes
- [ ] Session/device management

## Phase 7 — Notifications and reminders

- [x] Telegram support inherited from Steam Fusion
- [ ] Email notifications
- [ ] Discord notifications
- [ ] WhatsApp notifications
- [ ] Notification templates by event
- [ ] Per-event channel enable/disable
- [ ] Per-user notification preferences
- [ ] Configurable payment reminders
- [ ] Expiry/renewal/access/payment/violation notifications
- [ ] Delivery history and failure retry
- [ ] Mass contact/broadcast messaging

## Phase 8 — Usage, enforcement and reports

- [ ] Jellyfin playback/session ingestion
- [ ] Streaming activity log
- [ ] Download activity log
- [ ] Active streams by server/reseller/client
- [ ] Per-plan concurrent-stream enforcement
- [ ] Stop violating sessions and notify user
- [ ] Download entitlement enforcement
- [ ] Weekly download limits
- [ ] Download time restrictions
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
