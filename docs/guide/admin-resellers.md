# Resellers and reseller plans

CAPTAiNFiN treats a reseller subscription as the parent entitlement for a managed Jellyfin estate. A reseller pays a monthly fee for the right to manage up to a configured number of Jellyfin users; the reseller's own commercial relationship with those people stays outside CAPTAiNFiN.

## Reseller plans

A reseller plan defines:

- name, description and storefront visibility/order
- managed Jellyfin users per reseller
- one or more monthly currency/price variants
- Stripe/PayPal mapping for each supported price where required
- grace period and billing lifecycle policy
- concurrent streams per managed user
- downloads, transcoding, remux, Live TV, remote-access and 4K policy
- server class/placement rules
- included/excluded/all-library access

Plan setup follows the same broad structure as the customer/Stremio plan editors: identity, pricing, service/capacity, policy/access, placement/libraries and publishing.

## Managed-user capacity

One managed Jellyfin user consumes one reseller seat. Temporary suspension does **not** release a seat; deleting the managed Jellyfin user does.

The reseller cannot assign a separate CAPTAiNFiN retail plan to each managed user. Jellyfin policy is inherited from the reseller's active reseller plan.

A downgrade to a smaller managed-user allowance must not take effect while current usage exceeds the target limit.

## Creating and managing a reseller

Administrators manage reseller identity, active monthly plan, billing state and the managed Jellyfin estate. Reseller credentials use the normal activation/security flow; administrators do not need to know or retain the reseller's password.

## Reseller 360

The reseller management view should focus on operational information that CAPTAiNFiN actually owns:

- current reseller plan and billing state
- paid-through/grace state
- managed users used versus allowed
- managed Jellyfin accounts and server placement
- current streams/activity
- security/account state

It should not present downstream reseller revenue, customer resale prices or reseller-credit balances as active product concepts.

## Billing and currencies

Reseller plans are monthly-only but can expose multiple configured currencies/prices. Provider identifiers are price-scoped: a Stripe or PayPal mapping for one currency must never be reused for a different price/currency.

Commercial terms are snapshotted into the reseller subscription so later plan edits do not silently alter an agreement that has already been purchased.

## Historical reseller data

Older installations may still contain reseller sales/credit-ledger tables and records. They are retained only where required for safe migration, audit or compatibility. Do not build new runtime behavior on those historical structures.

## Security

Reseller two-factor authentication is optional unless the administrator enables platform policy requiring it for reseller sign-ins.
