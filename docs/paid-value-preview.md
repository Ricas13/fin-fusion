# Unused paid value: evidence-only preview

The selected policy is to preserve actual remaining paid monetary value, not
the source catalogue price or a one-for-one transfer of days. This is the
first slice: **no plan changes, entitlement writes, refunds or provider calls**.

From the deployed image, an administrator can inspect one subscription UUID:

```sh
docker exec captainfin npm run billing:paid-value -- SUBSCRIPTION_UUID
```

The preview requires a completed immutable one-off checkout, exactly one
matching positive provider-authoritative payment record, identical currency and
cash amount, and a calendar term that matches the original purchase contract.
It refuses ambiguous, imported, recurring, mixed-credit, operator-granted,
refunded, disputed, extended, carried or open-plan-change cases. A Stripe
settlement in a different currency is deliberately not inferred to be the
customer's original payment amount. It reports an exact numerator/denominator
in minor currency units, so no rounding is selected yet.

This is a diagnostic snapshot, **not a promise of credit**. Financial history
can lag provider events. Before any mutation, revalidate live provider
collection and refunds, lock the customer and source, obtain the destination
price/currency and preserve value transactionally with a durable idempotent
transfer ledger. Existing Stripe recurring proration must not be duplicated.
The preview never substitutes a zero amount for missing evidence.

Further decisions: target valuation rate (normal vs discounted new price),
cross-currency conversion, affiliate/service-credit value, treatment of free
promotions, and residual fractions. Until explicit approval and appropriate
settlement/refund tests, complex cases stay manual.
