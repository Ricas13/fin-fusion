# Financial and recovery review — 2026-10-01

Baseline: `97ff998503f08063a89590b7cb4605dae5e718de` (main, PR #827).
This follows the review of the preceding 36 hours of merged PRs. It is a
source review and isolated regression exercise, not a production reconciliation
or a guarantee that every possible financial failure has been eliminated.

## Corrected defects

| Area | Failure | Correction and regression evidence |
| --- | --- | --- |
| Refund execution | A provider can complete a refund while its response is lost. A later confirmation recalculated a smaller quote and generated a different idempotency key, allowing a second cash refund. | Reuse the original durable operation and frozen quote by subscription identity, including legacy keys. The DB test failed with two remote refunds before the fix; now Stripe and PayPal simulations issue one refund across delayed and concurrent retries. |
| Refund recovery | Duplicate legacy operations or an unknown result older than provider idempotency retention could be replayed unsafely. | Both confirmation and automatic recovery stop ambiguous cases. Unknown results older than 23 hours become manual-review operations. A known provider refund ID can still be observed and reconciled. |
| Prepaid access | Subtracting a calendar-day interval from a later period spanning DST could shift queued access by an extra/missing hour. | A forward migration uses elapsed seconds. Regression tests check exact continuity and preservation of paid duration in UTC, London and New York. Historical migrations remain unchanged. |
| Financial reporting | PostgreSQL DATE fields became local-midnight JavaScript dates, then shifted to the preceding UTC day. Imported payments/refunds could disappear from accounting coverage. | Read coverage dates as text. A DB-backed test verifies authoritative imported payment/refund totals and webhook suppression in UTC, London, New York and Kolkata. |
| Watchdog | References to retired `steam-fusion-*` container names caused the watchdog to exit before probing the renamed app. | Match the current Compose fleet. Execute the real shell script against a mock fleet derived independently from Compose, including healthy and wedged app cases. |
| Backup recovery | Retired container names prevented readiness checks from completing during drills/restores. | Correct the runtime names. Execute drill and restore paths against the mock fleet; assert safety-backup ordering and final deployment verification. |
| Access integrity | A subscription finding used the customer ID, so the exact subscription repair was skipped. | Prefer subscription ID when a subscription finding has no row ID. Exercise scanner finding construction through the operator and repair owner. |

The analytics smoke fixture also now places its referral timestamp inside the
reporting window, avoiding a PostgreSQL microsecond / JavaScript millisecond
boundary race. This is a test correction, not a change to revenue calculations.

## Validation and limits

Local validation uses isolated PostgreSQL 17.10, Node 24.19.0, synthetic records,
mock provider responses and mocked container commands. CI uses Node 22.23.1 and
performs the release checks on Linux. No production database, provider balance,
charge, refund, deployment or restore is modified by this review.

The release checks cover checkout intent/recovery, immutable commercial
snapshots, discounts, affiliate credits, recurring billing, prepaid stacking,
cash-only refund limits, chargeback access termination, payment-event replay,
provider-operation recovery, provisioning and adversarial concurrency. The new
regressions are included in the standard fast/database suites.

Before calling a production installation reconciled, its real provider payments
and refunds must be compared with its stored operations and accounting records.
Existing duplicate refunds cannot be undone by a code fix. The forward migration
does not reconstruct historical prepaid queues that may already have shifted.
Manual-review refunds must be checked against the provider before an operator
takes another financial action; resetting their keys is not a safe retry.

The 23-hour unknown-outcome cutoff deliberately leaves a margin before
[Stripe's 24-hour idempotency-key retention boundary](https://docs.stripe.com/api/idempotent_requests).
The same conservative application policy is used for PayPal, whose refund request
IDs have [documented retention of up to 45 days](https://developer.paypal.com/api/rest/requests/).

## Further simplifications, in priority order

1. **Resolve runtime containers through Compose service IDs.** Watchdog and
   recovery should use one service-resolution helper instead of copying branded
   container names. Keep the behavioral fleet tests; do not remove recovery
   checks merely to shorten the scripts.
2. **Give financial date fields explicit contracts.** Return calendar dates as
   ISO date text and instants as UTC timestamps at the database boundary. Extend
   the timezone matrix to expense dates, import ranges and reporting periods.
3. **Make money reconciliation one read-only report.** Compare provider cash,
   imported accounting, refund operations and paid access by immutable purchase
   identity. Surface mismatches and uncertain outcomes in the existing operator
   workflow; avoid adding another system that automatically retries cash.
4. **Make database tests self-contained.** Some suites currently depend on server
   fixtures left by earlier tests. Shared fixture builders with scoped cleanup
   would let tagged commerce checks run independently and make failures easier
   to diagnose. Preserve the locking and race assertions.
5. **Consolidate commercial decisions, not safety mechanisms.** Extend the durable
   operation/frozen-request pattern to new financial actions instead of deriving
   retry identity from mutable prices, timestamps or balances. Keep leases,
   idempotency, immutable snapshots, outboxes and backup boundaries.
6. **Retire duplicate reporting readers only after comparison.** Compare old
   dashboard totals with the canonical ledger on representative fixtures before
   removing legacy paths. Payments, fees, credits, refunds and payouts need
   separate classification even if their UI is simplified.

These are follow-up proposals, not claims that those larger refactors are
implemented in this patch.
