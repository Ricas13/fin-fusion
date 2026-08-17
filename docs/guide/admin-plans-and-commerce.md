# Plans and commerce

Administrators use **Commerce → Plans** to define what customers can buy and what service policy they receive.

## Plan overview

The overview contains the plan name, description, audience, billing interval, duration, server class, visibility and acquisition state.

- **Visible** controls whether the plan appears in applicable storefronts.
- **Active** controls whether new acquisition or renewal workflows can select it.
- **Archived** retires the plan from new catalogue use while preserving historical records and existing paid-through contracts.

## Jellyfin policy

The Jellyfin tab controls playback-related policy such as concurrent streams, downloads, transcoding, remuxing, Live TV, remote access and 4K access.

Changes that affect live customers require an impact confirmation and reconciliation of affected accounts.

## Libraries

Library rules determine which Jellyfin libraries a plan is entitled to expose. Customer-level library selection can narrow visibility inside the plan entitlement, but cannot grant a library the plan does not allow.

## Placement

Placement rules determine which servers may host new accounts for the plan. Server class provides the broad pool; explicit placement eligibility can further constrain it.

## Pricing

Catalogue pricing stores the plan amount and currency. Existing provider checkout contracts and subscriptions retain their commercial snapshots rather than silently inheriting a later catalogue edit.

## Provider mappings

Stripe and PayPal mappings connect a CAPTAiNFiN plan to the corresponding provider-side product, price or billing plan. Mappings should be verified before enabling them for live checkout.

## Retiring a plan

Prefer **archive** when a product should no longer be sold. Do not delete historical subscription or transaction data to retire a product.
