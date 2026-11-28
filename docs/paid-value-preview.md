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
It refuses ambiguous, imported, recurring, operator-granted,
refunded, disputed, extended, carried or open-plan-change cases. Mixed one-off cash/service-credit purchases are supported only if the completed checkout has a matching applied reservation, a redeemed debit and complete valid funding allocations with no disputed reward or recovery history. Cash and credit components are reported separately. A Stripe
settlement in a different currency is deliberately not inferred to be the
customer's original payment amount. It reports an exact numerator/denominator
in minor currency units, so no rounding is selected yet.

This is a diagnostic snapshot, **not a promise of credit**. Financial history
can lag provider events. Before any mutation, revalidate live provider
collection and refunds, lock the customer and source, obtain the destination
price/currency and preserve value transactionally with a durable idempotent
transfer ledger. Existing Stripe recurring proration must not be duplicated.
The preview never substitutes a zero amount for missing evidence.

## Approved conversion policy

Use the normal destination price, not its promotional price. Convert GBP,
USD and EUR automatically with the same Frankfurter source as reporting,
but fetch and validate the direct currency pair: no fallback, no cached
estimated rates. Reference dates must be no more than seven days old
(weekends/holidays included); the observation and paid-value evidence must
be within five minutes. A missing/stale rate means retry, not guessing.
Use exact rational arithmetic, then round the final positive days up once.
Earned, verified service credit also retains value; free promotional access
is retained until expiry but generates no monetary credit. Unverifiable
historical payments remain manual review.

For a read-only **base catalogue price** conversion preview, pass the exact
destination plan_prices UUID as the second argument:

```sh
docker exec captainfin npm run billing:paid-value -- SUBSCRIPTION_UUID DESTINATION_PLAN_PRICE_UUID
```

This fetches a rate only if currencies differ. The normal calendar term
is measured from the source snapshot time for this preview; the final
settlement must use the verified destination term anchor and freeze the
rate, timestamps, source allocation and target price. Variant pricing,
credit-only purchases, carried/extension allocations, recurring provider mutations,
and the transfer/refund ledger are not implemented by this diagnostic.
No customer balance or entitlement is changed.
