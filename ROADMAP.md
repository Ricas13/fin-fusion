# Steam Fusion / CAPTAiNFiN Roadmap

This fork keeps the useful Steam Fusion reseller workflow while turning it into a production-grade multi-server platform.

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

- [ ] PostgreSQL data model and migrations
- [ ] Redis-compatible session and rate-limit storage
- [ ] Docker image and production Compose stack
- [ ] Structured audit log for admin/reseller/security actions
- [ ] Transaction-safe credit ledger
- [ ] Backup/restore tooling with encryption support

## Phase 3 — Multi-server support

- [ ] Manage multiple Jellyfin servers from the admin UI
- [ ] Per-server URL, API key and health status
- [ ] Assign clients/resellers/plans to a server or server pool
- [ ] Premium and Free server classes
- [ ] Server capacity/health-aware account placement
- [ ] Controlled client migration between servers
- [ ] Per-server policy templates for streams, downloads and transcoding

## Phase 4 — Plans and subscription lifecycle

- [ ] Configurable plans instead of hard-coded month extensions
- [ ] Trial, monthly, 6-month and annual terms
- [ ] Per-plan concurrent-stream allowance
- [ ] Per-plan download/transcoding policy
- [ ] Grace periods and renewal reminders
- [ ] Reseller pricing/credit costs per plan
- [ ] Idempotent expiry/reactivation jobs

## Phase 5 — Payments

- [ ] Provider abstraction
- [ ] Stripe integration
- [ ] PayPal integration
- [ ] Webhook signature verification and idempotency
- [ ] Automatic reseller credit purchases
- [ ] Automatic client subscription extension
- [ ] Payment/credit reconciliation
- [ ] Refund and chargeback state handling

## Phase 6 — Notifications

- [x] Telegram support inherited from Steam Fusion
- [ ] Email notifications
- [ ] WhatsApp notifications
- [ ] Notification templates
- [ ] Per-user notification preferences
- [ ] Expiry/renewal/low-credit/payment notifications
- [ ] Delivery history and failure retry

## Phase 7 — Usage statistics and reports

- [ ] Jellyfin playback/session ingestion
- [ ] Active streams by server/reseller/client
- [ ] Bandwidth and playback reporting
- [ ] Last activity and account utilisation
- [ ] Direct-play/transcode reporting
- [ ] Reseller sales/renewal/credit reports
- [ ] CSV export
- [ ] Admin dashboard trends

## Phase 8 — Identity and access

- [ ] TOTP two-factor authentication for admins
- [ ] Optional/required TOTP for resellers
- [ ] Recovery codes
- [ ] Session/device management
- [ ] Password-change workflow
- [ ] Account lockout/security event history
- [ ] Granular admin/reseller roles

## Phase 9 — Content requests

The original project already contains a basic content-request workflow. The fork will expand it rather than rebuilding it from scratch.

- [x] Basic reseller request and admin response
- [ ] Request type/status/priority
- [ ] Duplicate detection
- [ ] Radarr/Sonarr integration
- [ ] Automatic status updates
- [ ] Search-before-request flow
- [ ] Per-reseller/request limits
- [ ] Notification on fulfilment

## Phase 10 — CAPTAiNFiN product layer

- [ ] CAPTAiNFiN branding/theme
- [ ] Integration boundary for existing customer/subscription tooling
- [ ] Premium/Free plan mapping
- [ ] Reseller portal onboarding
- [ ] Admin operations dashboard
- [ ] Import existing Jellyfin users safely
- [ ] Production migration/runbook
