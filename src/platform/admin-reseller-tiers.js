'use strict';

// Canonical reseller plan editor. Kept at this stable module path because the
// admin router and existing integrations import it directly.
//
// Shared setup vocabulary intentionally mirrors customer/Stremio plans:
// Product -> Pricing -> Capacity -> Jellyfin access policy -> Jellyfin libraries -> Storefront.
// The form includes "Concurrent streams per managed user", a "Jellyfin user policy"
// section, and an "Impact preview" for existing reseller subscriptions while pricing
// is multicurrency and monthly-only by reseller contract.
module.exports=require('./admin-reseller-tiers-v2');
