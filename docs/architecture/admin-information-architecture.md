# Admin information architecture

CAPTAiNFiN separates product modules from shared business capabilities.

## Product modules

- Jellyfin
- Stremio
- Resellers

Each product module owns its operational surface: overview, delivery infrastructure, product plans and playback/activity. Product-module customer links always route into the shared Customers system with a product filter rather than creating a second customer implementation.

Resellers is intentionally a light shell until the reseller product is developed. Monthly-fee and credit-based reseller plans are expected to share one future Resellers module rather than becoming separate top-level products.

## Shared business capabilities

- Customers
- Commerce
- Operations
- Settings

Customers, orders, payments, discounts, affiliates, automation and platform configuration have one authoritative implementation. Product modules may deep-link to those shared surfaces with context, but they do not own duplicate copies.

## Current navigation

- Dashboard
- Jellyfin
  - Overview
  - Servers
  - Plans
  - Customers
  - Playback
- Stremio
  - Overview
  - Sources
  - Plans
  - Customers
  - Playback
- Resellers
  - Overview
  - Resellers
  - Plans
  - Users
  - Servers
  - Activity
- Customers
  - Overview
  - Customers
  - Tickets
- Commerce
  - Overview
  - Orders
  - Payments
  - Discounts
  - Affiliates
- Operations
- Settings

## Navigation rule

Do not create duplicate customer, order, payment, discount or notification systems for a product module. Prefer a contextual link into the shared surface, for example `/admin/users?service=jellyfin` or `/admin/users?service=stremio`.

Campaigns/marketing should be implemented later as one shared customer capability, not once per product module.
