# Resellers and reseller tiers

CAPTaINFiN treats the reseller subscription as the parent commercial entitlement for a reseller estate.

## Reseller tiers

A reseller tier defines the commercial capacity available to the reseller, including its recurring price, currency and seat limit. A **seat** represents a live downstream customer entitlement.

Temporary access suspension does not release a commercial seat. Ending the downstream service does.

## Creating a reseller

When an administrator creates a reseller they can set:

- portal username and email
- initial monthly tier
- manual entitlement period when applicable
- ledger currency
- downstream payment-method labels
- whether an owner Jellyfin account is allowed

The reseller completes its own activation flow. Administrators do not need to know or retain the reseller's password.

## Reseller 360

The reseller management page provides the operational view of the estate: tier, paid-through status, seats in use, customers, active streams, downstream revenue and account/security state.

## Downstream sales

Resellers record customer sales in their configured ledger currency. The payment method is a reporting label selected from the methods allowed by the administrator; CAPTaINFiN does not treat a reseller's manually recorded downstream payment as a Stripe/PayPal transaction unless an actual provider workflow exists for it.

## Grace and dunning

A reseller can enter billing grace depending on the tier/subscription policy. Estate access and commercial status should be managed through the reseller lifecycle controls rather than by manually editing customer subscriptions behind the lifecycle layer.

## Owner account

If enabled, a reseller-owned Jellyfin account consumes one active customer entitlement just like another live downstream account.
