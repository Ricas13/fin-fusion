# Streams Manager Feature Parity Target

This document defines the functional target for turning the Steam Fusion fork into a self-hosted CAPTAiNFiN account, subscription and media-server management platform that can replace Streams Manager for a Jellyfin-first deployment.

The target is **functional parity, not code/UI copying**. Plex-only operational workflows are tracked separately because they are not required for a Jellyfin-only cutover.

## Parity principles

1. The platform database is the source of truth for customer identity, plans, subscriptions, payments and entitlements.
2. Jellyfin accounts are provisioned representations of an entitlement, not the billing/customer identity itself.
3. Payment providers never directly control Jellyfin. Stripe, PayPal and other gateways emit verified events into one internal subscription lifecycle.
4. Direct customers, manually managed customers and reseller customers use the same subscription/entitlement model.
5. All automation must be idempotent and auditable.
6. Sensitive provider/server credentials are encrypted at rest and never exposed through normal UI/API/backup paths.

---

## 1. Identity, registration and customer accounts

### Streams Manager parity

- [ ] Separate **site login** identity from media-server/Jellyfin account identity
- [ ] User registration
- [ ] Email verification before account activation
- [ ] Password reset / lost-password recovery
- [ ] Ability to disable public registration
- [ ] Invite-only registration
- [ ] Referral-code registration when public registration is closed
- [ ] Optional required Discord identity during registration
- [ ] Customer profile view/edit
- [ ] Customer account dashboard
- [ ] Customer payment history
- [ ] Customer subscription status/history
- [ ] Customer can extend/change subscription
- [ ] Customer can change Jellyfin password
- [ ] Administrator can manually invite/create a customer
- [ ] Bulk invitations
- [ ] Pending invitation management
- [ ] Linked-user / household-account support
- [ ] Merge duplicate/replacement customer accounts while preserving history
- [ ] Change media-server username/email without losing subscription/payment history
- [ ] Customer session/device management
- [ ] TOTP 2FA
- [ ] Recovery codes

### CAPTAiNFiN extension

- [ ] Direct customer and reseller-created customer use the same customer model
- [ ] Optional magic-link/passwordless flow later
- [ ] Optional WhatsApp identity/notification destination

---

## 2. Administrator dashboard and operations

- [ ] Dashboard totals for customers, active subscriptions and servers
- [ ] Current active streams
- [ ] Server health/capacity overview
- [ ] Historical user-count charts
- [ ] Current revenue
- [ ] Projected revenue
- [ ] Recent payments
- [ ] Upcoming payments/renewals due
- [ ] Trial conversion metrics
- [ ] Reseller metrics
- [ ] Full customer detail page containing profile, subscription, payments, Jellyfin accounts, servers, invites and activity
- [ ] Search/filter/sort customers
- [ ] Bulk customer actions
- [ ] CSV/export tools
- [ ] Import tools
- [ ] Event/error log panel
- [ ] Audit log panel
- [ ] Mass contact/broadcast messaging
- [ ] Custom FAQ management
- [ ] Unmatched-payment reconciliation panel
- [ ] Pending invites panel

---

## 3. Multi-server media management

### Common / Jellyfin-first

- [x] Database supports multiple media servers
- [x] Server credentials can be encrypted at rest
- [ ] Admin UI to add/edit/test Jellyfin servers
- [ ] Enable/disable individual servers
- [ ] Server direct/public URL
- [ ] Server health status and last successful sync
- [ ] Maximum-user capacity per server
- [ ] Allow/disallow new paid subscriptions per server
- [ ] Allow/disallow trial subscriptions per server
- [ ] Server classes/pools (Premium, Free, Trial, etc.)
- [ ] Server location assignment
- [ ] Customer chooses nearest/desired server location where allowed
- [ ] Automatic server selection based on capacity, health, plan compatibility and location
- [ ] Manual server assignment override
- [ ] Bulk server migration
- [ ] One-customer server migration
- [ ] Reconciliation/sync when Jellyfin was changed outside the management platform
- [ ] Per-server activity logging toggle
- [ ] Per-server streaming enforcement toggle
- [ ] Per-server download enforcement settings
- [ ] Per-server trial eligibility
- [ ] Per-server 4K-transcode policy
- [ ] Per-server Discord role mapping

### Optional platform adapters for broader Streams Manager parity

- [ ] Emby adapter
- [ ] Plex/P-share adapter
- [ ] Plex-account/token/proxy management

---

## 4. Libraries and library groups

- [ ] Import/sync Jellyfin libraries from every server
- [ ] Continuous library reconciliation
- [ ] Hide individual libraries from subscription sharing
- [ ] Define reusable library groups/types
- [ ] Attach multiple library groups to a plan
- [ ] Tiered library packages (e.g. standard, 4K, premium)
- [ ] Per-server mapping of equivalent library groups
- [ ] Library statistics for dashboard/public-site use

---

## 5. Plans, products and entitlements

- [x] PostgreSQL plan model exists
- [x] Current CAPTAiNFiN trial/monthly/6-month/yearly plan seeds exist
- [ ] Multiple simultaneously available products/plans
- [ ] Price per plan
- [ ] Currency per plan
- [ ] Duration with granularity down to hours
- [ ] One-time fixed-duration plans
- [ ] Recurring plans
- [ ] Free trial plans
- [ ] Per-plan simultaneous stream/device limit
- [ ] Per-plan transcoding allowed/blocked
- [ ] Per-plan 4K entitlement
- [ ] Per-plan download entitlement
- [ ] Per-plan weekly download limit
- [ ] Per-plan library-group entitlements
- [ ] Per-plan server-pool/location eligibility
- [ ] Add-on products such as downloads or 4K
- [ ] Inactivate a plan while grandfathering existing subscribers
- [ ] Trial-specific stream/library/download restrictions
- [ ] Grace periods
- [ ] Upgrade/downgrade rules
- [ ] Proration rules where relevant
- [ ] Manual entitlement override with audit trail

---

## 6. Subscription lifecycle and automatic provisioning

- [x] Provider-neutral subscription model exists
- [x] Transactional subscription/credit service foundation exists
- [ ] Checkout creates pending subscription intent
- [ ] Successful payment activates entitlement
- [ ] Automatically choose a compatible server
- [ ] Automatically create/link Jellyfin account
- [ ] Apply plan libraries and policy
- [ ] Send welcome/access notification
- [ ] Renewals extend/continue entitlement idempotently
- [ ] Failed/past-due payment state
- [ ] Grace-period handling
- [ ] Expiration automatically disables/removes media access according to policy
- [ ] Renewal automatically restores access
- [ ] Cancellation-at-period-end
- [ ] Immediate administrative cancellation
- [ ] Manual subscription creation
- [ ] Manual subscription extension
- [ ] Trial-to-paid conversion without recreating the Jellyfin account
- [ ] Plan changes automatically reconcile Jellyfin permissions/libraries

---

## 7. Payments and reconciliation

### Payment modes

- [ ] Pay-as-you-go / fixed-duration purchases
- [ ] Recurring subscriptions
- [ ] Prepayment before expiration
- [ ] Manual payment entry

### Gateways

- [ ] Stripe
- [ ] PayPal
- [ ] Square
- [ ] SumUp
- [ ] Plisio / crypto gateway
- [ ] Per-gateway enable/disable switch

### Payment operations

- [x] Provider-neutral payment-event table exists
- [x] External event/provider IDs support idempotency
- [ ] Verified webhook processing
- [ ] Stripe Billing + Checkout Sessions
- [ ] Stripe Customer Portal
- [ ] PayPal recurring subscription adapter
- [ ] Transaction synchronization/reconciliation
- [ ] Import manually sent provider payments where supported
- [ ] Automatic payment-to-customer matching
- [ ] Unmatched-payment queue
- [ ] Administrator manual match
- [ ] Refund handling
- [ ] Chargeback/dispute handling
- [ ] Payment history and receipts
- [ ] Gateway transaction reference display
- [ ] Revenue reports
- [ ] Reconciliation/audit report

---

## 8. Discount codes, credits and referrals

- [ ] Discount/promo codes
- [ ] Expiry date on discount codes
- [ ] Usage limits
- [ ] Plan restrictions
- [ ] Fixed or percentage discount
- [ ] Referral codes
- [ ] Referral code can permit registration while public registration is disabled
- [ ] Referral attribution/history
- [ ] Optional referral reward/credit
- [x] Reseller credits/ledger foundation
- [ ] Reseller credit purchase through Stripe/PayPal
- [ ] Credit reconciliation and immutable ledger history

---

## 9. Payment reminders and notifications

### Notification channels

- [ ] Email
- [ ] Discord
- [x] Telegram inherited from Steam Fusion
- [ ] WhatsApp (CAPTAiNFiN extension)

### Notification system

- [ ] Template per event type
- [ ] Per-event channel enable/disable
- [ ] Per-customer notification preferences where appropriate
- [ ] Test notification action
- [ ] Delivery log
- [ ] Retry/failure state
- [ ] Payment due reminder schedule configurable by administrator
- [ ] Upcoming expiry reminders
- [ ] Payment received
- [ ] Subscription activated
- [ ] Trial activated
- [ ] Subscription expired
- [ ] Access granted
- [ ] Access disabled/removed
- [ ] Stream-limit violation
- [ ] Download-limit violation
- [ ] Transcode-policy violation
- [ ] Content request updates
- [ ] Password/security events

---

## 10. Streaming enforcement and activity

- [ ] Poll/ingest active Jellyfin sessions frequently
- [ ] Log user, server, device, title, IP and timestamp
- [ ] Optional IP geolocation (country/city where practical and privacy-appropriate)
- [ ] Per-customer activity history
- [ ] Global streaming-activity panel
- [ ] Enforce plan concurrent-stream/device limit
- [ ] Stop offending active sessions when limit is exceeded
- [ ] Show/send meaningful violation message where Jellyfin API/client behaviour permits
- [ ] Notify customer of violation
- [ ] Direct-play vs direct-stream vs transcode statistics
- [ ] Bandwidth statistics
- [ ] Server-level concurrency charts

Note: Streams Manager checks activity on a recurring interval and compares active devices/streams to the user's current plan. Our Jellyfin implementation should aim for a shorter event-driven/polling interval where practical while preserving idempotent enforcement.

---

## 11. Transcoding enforcement

- [ ] Allow/deny transcoding per plan
- [ ] Allow/deny 4K entitlement per plan
- [ ] Allow/deny 4K transcoding per server
- [ ] Detect prohibited transcodes
- [ ] Stop prohibited session
- [ ] Notify customer
- [ ] Log enforcement event
- [ ] Administrator exemption/override

---

## 12. Download enforcement and logging

- [ ] Enable/disable downloads per plan
- [ ] Weekly download-count limit
- [ ] Server download time windows/restrictions
- [ ] Detect download activity
- [ ] Log customer, server, title, progress, IP and timestamp when available
- [ ] Per-customer download history
- [ ] Global download-activity panel
- [ ] Notify on policy violation
- [ ] Administrator override

---

## 13. Device limits

- [ ] Track Jellyfin devices/sessions per customer
- [ ] Per-plan device/session policy
- [ ] Admin view of known devices
- [ ] Customer view of sessions/devices
- [ ] Revoke/log out a device/session where Jellyfin supports it
- [ ] Optional device-cap enforcement analogous to Streams Manager's Emby-device feature

---

## 14. Discord integration and role synchronization

- [ ] Discord bot configuration
- [ ] Optional Discord identity during registration
- [ ] Link customer to Discord account
- [ ] Subscriber role mapping
- [ ] Trial role mapping
- [ ] Per-media-server role mapping
- [ ] Automatically add roles on activation
- [ ] Automatically remove roles on expiration
- [ ] Optional kick from Discord server after entitlement expires
- [ ] Discord notification templates
- [ ] Periodic role reconciliation

---

## 15. Media request integrations

### Streams Manager-compatible adapters

- [ ] Overseerr integration
- [ ] Ombi integration
- [ ] Petio integration
- [ ] Create/remove linked request accounts on subscription lifecycle where supported
- [ ] Sync profile/permissions to request service

### CAPTAiNFiN-native request path

- [x] Steam Fusion has basic reseller content requests
- [ ] Customer content request UI
- [ ] Search before request
- [ ] Radarr integration
- [ ] Sonarr integration
- [ ] Duplicate detection
- [ ] Request quotas/limits
- [ ] Request status synchronization
- [ ] Fulfilment notification

---

## 16. Media maintenance tools

- [ ] User-facing "scan missing media" action
- [ ] Safe Jellyfin library/item refresh action
- [ ] Admin-only scan/refresh folder/library action
- [ ] User subtitle upload where technically safe/appropriate
- [ ] Audit and rate-limit media maintenance actions

---

## 17. Site customization / white label

- [ ] Custom domain
- [ ] Default hosted domain/subdomain configuration
- [ ] Logo upload/configuration
- [ ] Wallpaper/background
- [ ] Home page section 1 custom content
- [ ] Home page section 2 custom content
- [ ] Pricing-page custom content
- [ ] Subscription-page custom content
- [ ] Library-statistics custom content
- [ ] Custom theme
- [ ] Custom FAQ page
- [ ] Administrator contact information
- [ ] Site/page settings
- [ ] CAPTAiNFiN default theme

---

## 18. Imports, synchronization and reconciliation

- [x] Legacy Steam Fusion JSON importer exists
- [ ] Import existing Jellyfin users
- [ ] Import current Jellyfin libraries
- [ ] Match imported Jellyfin users to customers
- [ ] Import subscription/customer data from Streams Manager export
- [ ] Dry-run migration report
- [ ] Resolve duplicates/conflicts interactively
- [ ] Continuous server/user/library reconciliation
- [ ] Detect out-of-band account changes
- [ ] Repair drift without overwriting intentional overrides
- [ ] Export users/subscriptions/server assignments for disaster recovery

---

## 19. Server migration and account recovery

- [ ] Bulk migrate customers from one Jellyfin server to another
- [ ] Preserve customer/subscription/payment identity during migration
- [ ] Recreate equivalent policies/library entitlements on destination
- [ ] Validate destination capacity before migration
- [ ] Rollback/retry failed migrations
- [ ] Customer-level migration
- [ ] Merge replacement Jellyfin account into existing customer identity
- [ ] Re-invite/re-provision workflows

Plex-ban-specific account replacement workflows are not required for Jellyfin parity, but the generic account replacement/migration primitives should make equivalent recovery operations possible.

---

## 20. Roles and access control

- [ ] Super administrator
- [ ] Custom administrator roles
- [ ] Permission bundles / granular RBAC
- [ ] Reseller role
- [ ] Customer role
- [ ] Read-only/support/operator roles
- [ ] Per-action audit trail
- [ ] Enforce 2FA for privileged roles

---

## 21. Reseller functionality (Steam Fusion strength retained)

Streams Manager parity is the floor; the Steam Fusion reseller model remains an additional differentiator.

- [x] Resellers
- [x] Regular credits
- [x] Trial credits
- [x] Reseller-owned customers
- [x] Reseller notes/messages/basic content requests
- [ ] Reseller-specific plan catalogue
- [ ] Wholesale price/credit cost per plan
- [ ] Reseller Stripe/PayPal credit purchases
- [ ] Reseller sales/renewal analytics
- [ ] Reseller notification preferences
- [ ] Reseller custom branding/white-label option later
- [ ] Commission/referral model if desired

---

## 22. Mobile/PWA

Streams Manager documentation includes a mobile-app setup area. For the replacement:

- [ ] Responsive customer portal
- [ ] Installable PWA
- [ ] Mobile-friendly admin/reseller dashboards
- [ ] Push notifications later if useful

A native mobile app is not required for the first Streams Manager cutover unless a specific Streams Manager mobile-only workflow proves necessary.

---

## 23. Self-invite and onboarding flows

- [ ] Configurable self-invite flow
- [ ] Invite token expiry
- [ ] Restrict self-invite to approved domains/codes where desired
- [ ] Registration -> verification -> checkout -> provisioning -> welcome flow
- [ ] Trial registration flow
- [ ] Returning customer renewal flow
- [ ] Existing-Jellyfin-user claim/link flow
- [ ] Failed-provisioning recovery queue

---

## 24. Reliability, jobs and operations

- [ ] Persistent background job queue
- [ ] Idempotent scheduled jobs
- [ ] Server health checks
- [ ] Periodic user/server/library sync
- [ ] Activity ingestion/enforcement job
- [ ] Expiry job
- [ ] Payment reconciliation job
- [ ] Notification retry job
- [ ] Integration reconciliation job
- [ ] Dead-letter / failed-job queue
- [ ] Admin job-status dashboard
- [ ] Database backups
- [ ] Encrypted backup option
- [ ] Restore tooling
- [ ] Health/readiness endpoints
- [ ] Metrics/logging

---

## 25. Streams Manager features intentionally not required for Jellyfin-first cutover

These are platform-specific rather than account-management features. They can be implemented later only if CAPTAiNFiN adds Plex/Emby support.

- Plex account password/token refresh
- Plex proxy/query-parameter identity handling
- Plex Pass-specific behaviour
- Plex-ban-specific workflows and account-change blacklists
- Plex share invitations as the provisioning mechanism
- Emby-specific device APIs where Jellyfin has no equivalent

---

## Definition of Streams Manager replacement readiness

The existing Streams Manager instance can be retired only when all of the following are true:

1. Existing customers/subscriptions can be imported without changing Jellyfin credentials unnecessarily.
2. Direct signup, trial, payment, renewal, cancellation and expiration work end-to-end.
3. Stripe and PayPal webhooks are verified, idempotent and reconciled.
4. Plan entitlements are enforced on Jellyfin, including streams, downloads, transcoding and libraries.
5. Multi-server placement and migration are production-tested.
6. Email notifications and payment reminders are operational.
7. Admin can manage customers, subscriptions, payments and servers without touching the database.
8. Customer self-service covers password, subscription and payment management.
9. Streaming/download activity and policy violations are visible and auditable.
10. Backup/restore and rollback procedures have been tested.
11. A shadow period shows parity between Streams Manager and this platform before cutover.
12. No secrets or plaintext customer media passwords are stored in normal database/backups.
