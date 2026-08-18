# Admin and customer IA release contract

This release intentionally simplifies CAPTAiNFiN around the workflows that remain active.

## Removed

- Invitation onboarding is retired. Historical database migrations remain immutable for upgrade compatibility, but `/invite` fails closed and the administration link is retired.
- Reseller credits/wallets remain retired. Resellers use monthly seat plans only.

## Administration

- People focuses on Customers and Jellyfin import/claim workflows.
- Customer-specific Jellyfin password support is reached from Customer 360 instead of permanent navigation.
- Playback operations belong to Servers.
- Administrator profile, personal notifications and personal security are separated from global Settings.
- Trial/free-access policy belongs to Plans → Access Rules.
- Refund/dispute/chargeback policy belongs to Payment Providers → Payment Risk.
- Storefront ordering uses the visual Storefront order workflow; Free Access remains pinned above normal plan cards.
- Customer, Stremio/bundle and reseller plan configuration follow the same product/pricing/availability/delivery/policy/storefront mental model.

## Customer portal

Customer navigation is task based: Overview, Streaming, Plans & billing, Activity, Notifications, Security, Benefits and Help & support.

Customer-facing state uses plain language such as Ready, Setting up and Needs attention. The portal avoids internal terms such as reconciliation, placement and entitlement where they are not required for the customer to act.

First access after Stripe, PayPal, Free Access, trial or activation routes the customer back through the welcome/setup experience. Plan-change cards explain whether a Stripe change is immediate/prorated or scheduled for the next renewal before the customer proceeds. PayPal customers are told when an existing recurring agreement must first have renewal stopped.

## Resellers

A reseller buys a monthly plan with a managed Jellyfin-user allowance. The plan defines streams, transcoding, server class, library access and other technical policy inherited by managed users. The reseller handles downstream pricing, billing and customer relationships outside CAPTAiNFiN. Reseller plans support GBP, USD and EUR provider mappings.
