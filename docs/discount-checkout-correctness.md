# Discount checkout correctness

This branch enforces two checkout invariants:

- Fixed-value promo codes are valid only in the currency they were created for. Preview and checkout both validate against the resolved plan currency before a discount reservation is created.
- A one-time checkout whose promo covers the full price settles locally without creating a fake Stripe, PayPal, or Plisio payment identity. Capacity, the local subscription, promo redemption, and checkout completion are committed atomically.

Recurring Stripe subscriptions remain provider-owned even when the first invoice is fully discounted so future renewals stay attached to the real Stripe subscription.
