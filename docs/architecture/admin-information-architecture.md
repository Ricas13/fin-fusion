# Admin information architecture

CAPTAiNFiN separates product modules from shared business capabilities while keeping the permanent admin navigation deliberately small.

## Product modules

- Jellyfin
- Stremio
- Resellers

Each product module owns its operational surface. Product-module customer links always route into the shared Customers system with a product filter rather than creating a second customer implementation.

Resellers is intentionally a light shell until the reseller product is developed. Future reseller commercial models should share one Resellers module rather than becoming separate top-level products.

## Shared business capabilities

- Customers
- Commerce
- Operations
- Settings

Customers, orders, payments, discounts, affiliates, automation and platform configuration have one authoritative implementation. Product modules may deep-link to those shared surfaces with context, but they do not own duplicate copies.

## Condensed navigation

The sidebar contains only operator starting points. Specialist workflows remain routable and are exposed as responsive control-room cards on their parent page instead of consuming permanent navigation space.

- Dashboard
  - Dashboard
- Jellyfin
  - Servers
  - Playback
- Stremio
  - Stremio
- Resellers
  - Resellers
- Customers
  - Customers
  - Support
- Commerce
  - Plans & Storefront
  - Orders & Growth
  - Payments & Billing
- Operations
  - Provisioning
  - Automation
  - Backups & Recovery
- Settings
  - General
  - Security
  - Connections
  - System

Examples of contextual child workflows include Needs Attention under Dashboard; placement and Libraries under Servers; household/IP access under Stremio; customer activity under Customers; Storefront order and access rules under Plans; Discounts and Affiliates under Orders & Growth; Billing, provider mappings and payment risk under Payments & Billing; customer moves and access consistency under Provisioning; Audit log under Automation; Configuration Transfer under Backups & Recovery; Branding and Support & Legal under General; and notification/email/request-service controls under Connections.

## Navigation rule

Do not create duplicate customer, order, payment, discount or notification systems for a product module. Prefer a contextual link into the shared surface, for example `/admin/users?service=jellyfin` or `/admin/users?service=stremio`.

Do not add a new sidebar destination for a specialist workflow when it can be reached from an existing control room. Keep the route stable for bookmarks and direct links, make its parent sidebar item active, and expose it through a card or action on that parent workflow.

Campaigns/marketing should be implemented later as one shared customer capability, not once per product module.
