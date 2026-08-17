# Reseller Guide

## What a reseller subscription provides

A CAPTAiNFiN reseller plan is a monthly **managed Jellyfin user allowance**. The plan defines how many Jellyfin users the reseller may manage and the Jellyfin policy those users inherit.

Typical plan policy includes:

- managed-user limit
- concurrent streams per managed user
- downloads
- video/audio transcoding and remux permissions
- remote access and Live TV policy
- 4K policy
- server placement/class
- included or excluded Jellyfin libraries

The reseller's own customer billing, pricing, invoicing and CRM activity happen outside CAPTAiNFiN.

## Managed Jellyfin users

The reseller portal is for Jellyfin access management only. A reseller can:

- add a Jellyfin user while a seat is available
- reset that user's Jellyfin password
- suspend or resume access
- delete the Jellyfin user

One managed Jellyfin user consumes one reseller seat. Suspending a user keeps the seat occupied. Deleting the managed Jellyfin user releases the seat.

Managed users inherit the reseller plan's Jellyfin policy automatically; the reseller does not choose or sell a separate CAPTAiNFiN customer plan for each user.

## Monthly plans and billing

Reseller plans are monthly-only and may expose more than one supported currency/price when configured by the administrator. Stripe and PayPal self-service checkout are available only where the administrator has configured and verified the corresponding provider mapping for that exact price.

The portal shows the active reseller plan, paid-through date, seat usage and billing state. Cancelling renewal does not remove already-paid access before the paid-through date.

Plan changes remain subject to seat-capacity and provider rules. A move to a lower allowance cannot take effect while managed-user usage exceeds the target plan limit.

## Security

Resellers can use two-factor authentication when enabled by platform policy. Administrators may optionally require it for reseller sign-ins.

## What is intentionally not in the reseller portal

CAPTAiNFiN does not provide a reseller credit wallet, downstream sales ledger, per-customer resale pricing, customer invoices or reseller CRM. Historical database records from older versions may remain for migration/audit compatibility, but they are not part of the live reseller workflow.
