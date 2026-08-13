# UI Design Direction

The product UI should feel familiar to Jellyfin and Emby administrators without copying proprietary assets, logos, or source code.

## Core shell

- dark charcoal background and panels
- fixed left navigation on desktop
- compact top application bar
- restrained blue/cyan accent
- square-to-softly-rounded cards rather than oversized marketing cards
- dense administration tables with clear hover states
- responsive collapse for mobile

## Navigation model

Server: Dashboard, Activity, Users, Servers, Libraries

Business: Plans, Payments, Resellers, Requests

System: Notifications, Security, Settings

Only implemented destinations should be interactive. Future destinations may be shown disabled for orientation.

## Interaction rules

- operational dashboards default to read-only views
- destructive or service-impacting actions require explicit confirmation and audit logging
- security-sensitive configuration should not be reduced to a casual one-click toggle
- customer-facing pages use the same shell vocabulary with simpler navigation
- no external icon/font dependency is required for core operation

## Visual goal

Familiar media-server administration ergonomics, CAPTAiNFiN branding, and consistent behavior across admin, reseller, and customer portals.
