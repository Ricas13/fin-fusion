# CAPTAiNFiN admin deep audit — August 2026

This is the working inventory for the full operator-product audit. Every visible control must have a clear owner, discoverable location, successful happy path, actionable failure path and browser-level regression coverage.

## Audit lenses

1. Functional integrity — every visible action reaches a real route, validates correctly, preserves auth/CSRF boundaries and provides an actionable result.
2. Information architecture — settings belong with the job they control, not with the implementation module that happens to own them.
3. Workflow integrity — common operator journeys are short, predictable and reversible where practical.
4. Failure quality — expected failures say what failed and what to do next; generic HTTP-status errors are not acceptable UI.
5. Responsive usability — desktop and narrow screens preserve hierarchy without overflow or competing navigation.

## Canonical operator areas

- Dashboard — state and attention, not configuration.
- People — customers, resellers and customer/service activity.
- Servers — delivery infrastructure and discovered libraries.
- Commerce — products/plans, prices/provider mappings, discounts/referrals and payments.
- Automation — provisioning, request-service lifecycle, migrations, policy drift, jobs and audit/event execution.
- Settings — platform-wide defaults/infrastructure, the signed-in administrator profile, branding, integrations, security, operations and backups.

## Core journeys to simulate

- Administrator signs in, updates profile/reporting preferences and configures personal notifications.
- Administrator configures global notification infrastructure, validates it, then chooses personal event delivery.
- Create Jellyfin, Stremio, bundle and reseller-facing products; configure delivery, inventory, prices/provider mappings, publish, edit and archive.
- Create/invite/import/claim a customer, grant or sell access, provision Jellyfin/Stremio, reset credentials, change plan, renew/cancel/expire and restore.
- Configure/test a server, discover libraries, place customers, detect policy drift and migrate a customer safely.
- Configure the request service, set per-plan limits, synchronize users, suspend on expiry and restore on renewal.
- Configure Stripe/PayPal mappings without exposing provider implementation details in unrelated plan-edit screens; exercise checkout/reconciliation/failure handling with mocks.
- Create/manage resellers, tiers, capacity/credits, downstream customers and suspension/restoration.
- Run/inspect automation jobs and audit events.
- Create/restore backups and export/import configuration through the owning Backups & Transfer workflow.
- Verify storefront/customer portal behavior for every product/lifecycle state.

## Findings being actively addressed

- Personal notification settings and global notification infrastructure must remain visibly distinct. Personal notification pages belong to My Profile; global channel infrastructure belongs to Settings > Notifications.
- The personal event-routing matrix is too flat for the number of events. It needs category grouping and clearer channel readiness without hiding advanced per-event control.
- The shared enhanced-form client can collapse a useful server-rendered 4xx explanation into `Request failed (NNN)`. Server error text must be preserved safely.
- Plan creation has regression coverage for generic direct/reseller products but not the exact Stremio/bundle browser workflows. Those must become first-class tests.
- Plan creation mixes product identity, commercial terms, inventory and delivery policy. The audit will decide which fields are required at creation versus better owned by post-create Delivery/Inventory/Payments workflow pages.
- Hidden workflow pages need an explicit parent navigation owner so breadcrumbs can identify the specific page while the sidebar highlights the broader operator job.

## Exit criteria

The audit is complete only when the authenticated browser suite plus domain-specific workflow tests cover every canonical journey above, all CI/security/release checks are green on the exact PR head, and the resulting admin navigation has no known duplicate/legacy destination exposed to normal operators.
