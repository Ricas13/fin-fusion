# Grandfathered recurring subscriptions

CAPTAiNFiN treats a grandfathered recurring provider agreement as continuity-only access.

- Existing customers may keep the commercial terms of the provider subscription they already hold.
- Hidden, archived, or otherwise unavailable legacy plans/prices are not valid for new acquisition.
- A linked recurring provider subscription continues to synchronize independently of storefront visibility.
- A failed renewal moves the linked entitlement into provider delinquency handling and suspends managed access until payment recovers.
- Successful provider recovery restores managed access automatically.
- Cancellation/expiry is terminal for that grandfathered agreement. Paid-through access is honoured until the provider/local entitlement period ends, after which managed access is removed.
- A former customer who later returns must purchase a currently available plan; CAPTAiNFiN does not recreate or re-offer the legacy commercial price.
- Provider webhook retries for the same invoice are one operational incident, not one incident per delivery attempt.
- Terminal provider state wins over out-of-order webhook events so a late failure/paid event cannot resurrect a cancelled agreement.

The customer/subscription provider identity must be linked deterministically. Email similarity alone is not sufficient to attach a provider subscription or change access.
