# Prepared monetary transfer (initial execution path)

Default off. Do not set PAID_VALUE_TRANSFER_ENABLED=true until all web and webhook workers run this migration and end-to-end settlement, reversal and rolling deployment tests pass.

Supported candidate: one active verified cash-only one-off purchase (Stripe, PayPal or Plisio), same service lane, changing access to a new Stripe recurring agreement at a verified normal base or access-variant price. No multiple overlapping sources, mixed credits, unsupported currencies, recurring-to-recurring replacement, or operator grants. Existing identical-access carry is unchanged. A new positive paid first Stripe period is required; zero-price promotions need a separate verified settlement path.

Preparation checks source and destination before checkout; settlement revalidates live payment and actual destination first billing term, freezes exact rational monetary value and FX evidence in the carry ledger, replaces old entitlement and grants the converted days in the same transaction. Existing reversal/return paths use the same carry ledger. Unexpected evidence fails closed. No new refunds or provider mutations occur. Round up once to whole service days; no monetary rounding before conversion.

This is a scoped initial implementation, not a claim of full upgrade/downgrade support. Review database and provider-specific regression coverage before enabling.

Same-access purchases with a different recorded currency must also use monetary valuation rather than copying days one-for-one. A completed transfer acknowledges replays without resurrecting reversed value. The receiving Stripe checkout and first invoice must both attest the same positive amount and currency; mixed-credit receiving checkouts remain unsupported.
