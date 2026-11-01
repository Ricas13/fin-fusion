# Design: record an external Stripe/PayPal payment, and the automatic Plisio sweep

Status: DESIGN ONLY, nothing built. For review before implementation. Target repo: Ricas13/fin-fusion (main at ca0308fb).

## 0. Why

Payments must be fully automatic. The only manual money action the operator should ever need is: "a customer paid me outside the portal
(directly in Stripe or PayPal) — give them their plan and link that payment". Everything else (unpaid invoices, lapsed subscribers,
late payments) must resolve by itself. Money is at stake, so the design prefers refusing over guessing.

## 1. Facts about the current code that this design builds on

- Money ledger: `payment_history_transactions`, written only through `provider-financial-state.js recordTransaction()`;
  unique on `(provider, provider_transaction_id)`; upsert is idempotent. Providers: stripe, paypal, plisio.
- Access grant: `lifecycle.activatePurchase(input)` (plan, customer, provider, providerSubscriptionId?, commercialSnapshot incl. kind
  `subscription_extension`); it enforces audience, Stremio acquirability, one live recurring per service, and releases inactivity holds.
- Already-existing live fetch helpers: Stripe `live-stripe-payment-history.upsertCharge` (charge + balance transaction), PayPal
  `paypal.getCapture / recordCompletedCapture`.
- Existing "manual payments" (`manual-payment-ledger.js`, table `manual_payment_events`) is a cash/bank/crypto NOTE ledger. It does not
  grant access and does not touch the financial ledger. It stays as is (renamed in the UI to "Note a cash/bank payment").
- Checkout intents already record portal-started payments; a payment made through the portal must never be recorded a second time here.

## 2. Feature A: "Record a payment made outside the app" (Stripe / PayPal)

### 2.1 Operator flow (customer page → Payments card)
1. Choose provider (Stripe or PayPal), paste the provider payment ID (Stripe `pi_…`/`ch_…`/`in_…`; PayPal capture ID or order ID).
2. Choose the plan to give. Optional note.
3. Press "Look up payment". Server fetches the payment FROM THE PROVIDER and shows a read-only preview:
   amount, currency, status, date, payer email/name, refunded amount, whether already recorded, and the plan price for comparison.
4. Press "Record and activate" (second step, bound to the preview by a signed token, see 2.3).

The operator never types the amount or currency: they come from the provider. If the provider cannot be reached, the form refuses
("try again shortly"); there is no unverified mode.

### 2.2 Refusals (all with a plain-language reason, nothing written)
- Provider lookup fails or the ID does not exist / belongs to another Stripe account or PayPal merchant.
- Payment not fully captured/paid; refunded or partially refunded; disputed.
- Already recorded in the ledger (shows where: which customer, which date) — including payments made via the portal.
- A checkout intent for this provider ID exists (portal payment): do NOT create a second grant; show "This was a portal checkout" and
  offer the existing confirm/recovery action instead.
- Currency differs from the plan's price currency. Amount below the plan price → refused unless the operator ticks
  "Amount differs from plan price" and gives a reason (stored in audit). Amount above price is allowed with a warning.
- Customer already has a live subscription for the same service lane with a different plan → shown as "this will extend / replace",
  using the existing prepaid stacking rules; no new rule invented here.

### 2.3 Atomicity and idempotency
- One database transaction: lock the customer row; re-check "not already recorded" under lock; insert ledger row (kind
  `charge`, `metadata.source='operator_recorded'`, `recordedBy`, `note`); call the activation path; write `audit_log`
  (`admin.payment.external_recorded`) with provider, ID, amount, plan, subscription id, operator.
- Idempotent on `(provider, provider_transaction_id)`: pressing the button twice, or a later Stripe webhook / history sync / PayPal
  event for the same payment, produces no second ledger row and no second grant (the upsert path is reused).
- Preview → confirm uses a short-lived signed token over (customer, provider, id, plan, verified amount, currency); the confirm step
  re-fetches from the provider and refuses if anything differs from what the operator saw.
- Access type: one-off payment (`billing_mode='payment'`, not recurring), period from the plan duration, no provider subscription linked.
  Linking an ongoing Stripe/PayPal subscription is the existing "link subscription" tool and stays separate.

### 2.4 Afterwards
- Payments card shows the entry tagged "Recorded by <admin>"; customer log shows a plain-language line.
- Customer notification `payment.received` follows the existing preference (default on; operator checkbox "don't email customer").
- Reversal = the existing refund/operator-refund flow. No "undo record" button.
- Rate limit + CSRF + admin-only (same as other billing writes); owner capability not required.

### 2.5 Open questions for the reviewer
1. `recordTransaction` uses the shared `query`, not a transaction client. Is a transaction-aware variant needed so the ledger row and
   the grant commit together, or is the idempotent upsert plus a compensating check enough?
2. Is "refuse unless amount ≥ plan price (or reason given)" the right guard, or should any mismatch require the reason?
3. PayPal: accept order ID and capture ID, or capture ID only?
4. Should a payment older than N days be refused (stale evidence)?

## 3. Feature B: automatic Plisio sweep (no operator action)

### 3.1 New finding from production (`plisio:list-shape` at ca0308fb)
- `/api/v1/operations` returns `operations`, `_links`, `_meta{totalCount,pageCount,currentPage,perPage}`.
- Unfiltered `totalCount=4` (all `completed`; 3 are `type=invoice`) but every request returned 0 items.
- Every request sent `page=1` and the reply said `currentPage=2` → Plisio's `page` is ZERO-based; `page=1` is the second (empty) page.
- `limit=5` is honoured (`perPage=5`); `per-page` is ignored (perPage stayed 10).
- So the list works; we were reading the wrong page. Nothing about the account is wrong.

### 3.2 Sweep behaviour
- Every 5 min (inside the existing recovery worker): page=0, `limit=50`, walk pages while `currentPage-1 < pageCount`, hard cap 20 pages.
  Self-check each response: `_meta.currentPage == requestedPage+1`, otherwise stop and raise a provider-contract incident (so a
  future API change is loud, not silent).
- For each operation: look up our checkout intent / ledger row by `txn_id` or `order_number`.
  - Known and already completed: nothing.
  - Known intent, provider says completed/mismatch-overpaid: verify through the existing per-ID path (`confirmCheckout`) — the
    list is only a discovery hint, never trusted for amount or status.
  - Known intent, provider terminal-unpaid (expired/cancelled/error): existing close logic.
  - Completed at Plisio but unknown to us: "unmatched receipt" incident (not a loss incident), shown to the operator with the ID.
- Only the per-ID verified result can grant access (unchanged). Rate: ≤ 1 list request per cycle plus per-ID calls for changes.

## 4. Test plan (summary)
Unit: validation/refusal matrix (2.2), token binding. Real-DB: double submit, webhook race, portal-payment duplicate, refunded
payment, wrong currency, concurrent record for two customers (one wins). Sweep: page-base self-check, empty/partial pages, unknown
operation → incident, hostile list data. Existing suites must stay green; no change to expiry, renewal or refund behaviour.

## 5. Out of scope
Stripe `past_due` policy; late-retry recovery after local expiry; PayPal one-off polling. Tracked separately.
