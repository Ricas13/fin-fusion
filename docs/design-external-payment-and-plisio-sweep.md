# Design v4 (v2 + v3 + v4 review amendments): record an external Stripe/PayPal payment, and the automatic Plisio sweep

Status: DESIGN ONLY, nothing built. v2 incorporates the first design review (BUILD AFTER CHANGES). Target: Ricas13/fin-fusion main (ca0308fb).
This file lives on branch `claude/full-analysis-hpmuwq`.

## v4 amendments (these SUPERSEDE v2 and v3 wherever they conflict)

**B1. Protect the payment reference.** An externally fulfilled one-off subscription (and any subscription whose `provider_subscription_id` is a
canonical payment id) can NEVER be the target of the manual recurring-link workflow (`manual-subscription-link` / `lifecycle.attachDiscoveredProviderSubscription`),
nor any other writer that replaces `provider_subscription_id`/`source`/`billing_mode`. The guard is in the shared write path (not only the UI) and has a test.

**B2. Payment-identity lock and loss tombstone.** One lock hierarchy for every writer, always in this order:
(1) customer row → (2) canonical payment identity (advisory lock on hash of provider+canonical id, plus the fulfilment / loss row) → (3) parent subscription →
(4) extension rows → (5) ledger / audit / outbox writes. Existing writers that take locks in another order (`incidents.record`, extension revoke) are adapted
and covered by two-direction lock-order tests (confirm vs refund, refund vs confirm).
A refund/dispute/chargeback fact is first written to a durable `payment_loss_facts` row keyed by canonical id (a tombstone), EVEN IF no fulfilment exists yet.
Confirmation re-reads the tombstone under lock (2) immediately before commit and refuses; a fulfilment that commits after a tombstone is impossible.
Stripe history sync and the scheduled re-poll write the same tombstone through the same function, with a durable cursor so a missed webhook cannot leave a
refunded fulfilment active.

**B3. Commercial refund rule (replaces the "proportional days" idea; `refund-policy.js` only validates cash and has no day rule).**
- Partial refund: financial record + admin incident only. NO automatic reduction of paid time.
- Full refund, or lost dispute / chargeback: reverse that purchase and recompute access.
- Open dispute: access kept (existing policy), admin incident raised.
- Base purchase reversed while later paid extensions remain: new deterministic timeline. Each purchase stores an immutable contribution (days, purchase time,
  order). Access end = start of the term + sum of surviving contributions, evaluated in purchase order; the existing `terminateForRefund` (which zeroes
  `service_extension_days`) is NOT used for this case. Fully covered by tests, including calendar boundaries and multiple extensions.
If partial-refund day reduction is ever wanted it is a separate, separately reviewed commercial policy.

**B4. Ownership: strict-only in the first release.** Allowed evidence: provider customer/payer already linked to THIS customer, or server-authored metadata
naming THIS customer. No attested mode in the first release. A later, separately reviewed attested mode would need ALL of: owner-only capability + re-authentication,
independent evidence beyond a billing email, no conflicting owner anywhere locally, exact price/currency, ≤ 90 days, no existing fulfilment, no refund/dispute,
immutable audit of the evidence examined, a persistent "attested" marker in the incident feed; and it may never override a payment/identity positively linked to a
different customer. Direct payers are handled meanwhile by a separate reviewed step that links the provider customer to the customer account.

**B5. One lease per operation.** Checkout recovery and the Plisio sweep share a per-operation claim (`claimed_until`, owner, attempt count) taken BEFORE any provider call, with
expiry and retry rules, so the same invoice is never verified twice concurrently. Both still end in the idempotent per-ID path under the checkout row lock.

**B6. Attempt audit.** Previews, refusals and failed provider lookups go to a bounded, redacted `external_payment_attempts` log (reason code, operator, provider, canonical
id hash/last 4, no payloads, retention-limited), separate from the committed fulfilment audit.

**Build order (each its own PR, each separately reviewed):**
1. Report-only Plisio sweep: page-zero fix, structural pagination checks, per-operation progress table, deduped incident for unmatched receipt / contract change. No ledger, access or checkout mutations.
2. Strict per-ID Plisio verification mode + shared operation lease + fail-closed activation.
3. External-payment read-only preview + ownership checks (no writes besides attempt log).
4. Canonical fulfilment / transaction-aware ledger + apply primitives (+ outbox), behaviour-pinned against current checkout paths.
5. Money-loss tombstones + reconciliation (webhook, history sync, re-poll).
6. External-payment confirm behind a disabled-by-default setting.
7. (Optional, later) attested ownership.

## v3 amendments (these SUPERSEDE v2 wherever they conflict)

**A1. Price invariant (Blocker).** The provider-verified gross amount and currency must EQUAL the immutable payable price of the selected plan,
service lane and allowance (the same price contract a portal checkout would have snapshotted, taken at preview time and stored in the token).
No operator-entered amount, no implicit discount, no tolerance, no currency conversion. A genuine £5 payment can never buy a £50 plan.
(The v2 "below price with a reason" idea is removed.) Section 2.2's amount/override rules are void.

**A2. Canonical identity and base-purchase representation.**
- Stripe canonical = PaymentIntent, which must resolve to exactly one succeeded charge; the charge id and balance-transaction id are one-to-one aliases.
  Invoice / order ids are PARENT references, used for discovery only, never unique aliases and never interchangeable with a payment.
- PayPal canonical = capture id. An order may hold several captures, so the order id is a parent reference (non-unique); an order id alone is refused.
- The base one-off subscription stores the canonical payment id in `subscriptions.provider_subscription_id` with `billing_mode='payment'`
  (a payment reference, not a recurring agreement; the existing unique (source, provider_subscription_id) index then also guards it, and the
  existing incident / refund handlers find it). Extension purchases use `subscription_access_extensions.provider_payment_id`.
  The fulfilment row references the base subscription OR the extension row; this link is mandatory.
- Duplicate handling: a claim collision is "already applied" ONLY if customer, merchant account/environment, plan and entitlement are all identical
  to the stored row; any difference is an identity CONFLICT (refused, one deduped incident), never a silent success.
- A payment already in the financial ledger but with no access effect (history sync attributed it, nobody fulfilled it) is ELIGIBLE: reuse the ledger
  row after re-verifying identity, ownership and money state. "Recorded" and "fulfilled" are different states.

**A3. Atomic boundary.** Provider fetch and all provider-state checks happen BEFORE the DB transaction. The transaction then only does local work:
lock customer → re-validate locally → claim fulfilment row → ledger row → access effect → audit → outbox row. This needs:
(a) an extracted transaction-aware activation/apply primitive (current `lifecycle.activatePurchase` opens its own transaction and locks the same
customer; it must not be called from inside another transaction; it also does post-commit reconcile work),
(b) a transaction-aware ledger writer used by this path and made to coexist with the PayPal live-capture writer that upserts the ledger directly,
(c) a durable post-commit outbox for provisioning/reconcile, customer notification and anything touching external servers, retried until done.
No external call happens while the customer lock is held.

**A4. Money-loss convergence (replaces 2.7).** Webhook, history sync and a scheduled provider re-poll all converge on the fulfilment record:
- Add fulfilment-aware resolution to `incidents.record`/reversal so a refund or dispute on the canonical id finds the purchase even when only the
  history sync saw it (today the Stripe history sync writes refund ledger rows but never terminates access).
- Cases to specify and test: partial refund (reduce purchased days proportionally using the existing refund policy, not all-or-nothing), full refund,
  OPEN dispute, lost dispute / chargeback, dispute won, refund arriving before / during / after confirm, missed webhook.
- Open dispute policy for externally recorded purchases: existing code deliberately keeps access while a dispute is open. v3 keeps that default
  (consistency, no surprise cut-offs) and only flags an admin incident; reversal happens on lost dispute/chargeback. (Owner may choose a stricter
  hold; this is one of the open questions.)
- Base purchase refunded while later extensions remain: specify recompute from remaining purchases — paid-through is recomputed from the surviving
  purchases' days starting at the term start, never left anchored to the refunded base period.

**A5. Ownership (replaces 2.3).** Email alone is NOT proof (a payer can type anyone's email). Allowed evidence for automatic recording:
(a) the Stripe customer / PayPal payer id is already linked to THIS customer (existing provider identity, not linked to anyone else), or
(b) the payment carries server-authored metadata naming THIS customer (customerId we wrote), or
(c) an attested mode — OFF by default, owner-capability only — where the operator confirms "this payer is this customer", and the payer email also
equals the customer's account email exactly with no other customer holding it, the price invariant (A1) holds, the payment is ≤ 90 days old, and a
typed confirmation is required. Every attested record is audited as `attested_ownership` and shown in the admin incident feed.
*Tension to resolve:* a customer who paid you directly usually has NO linked identity or metadata, so with (a)+(b) only the feature would refuse the
main use case. The owner must choose: ship (c), or ship (a)+(b) only and handle direct payments by first linking the provider customer to the customer
account via a separate reviewed step.

**A6. Plisio verifier and cursor.**
- New strict verification mode used only by the sweep: requires the per-ID provider response to contain status, amount AND currency; does not fall
  back to callback / intent values for monetary evidence; missing facts → defer + deduped incident, never a grant.
- Contract violations are split: STRUCTURAL (wrong schema, `currentPage != requestedPage+1`, items missing when totalCount>0 on a first sweep) → one deduped
  "provider contract changed" incident; TRANSIENT (counts differ because the list changed between pages) → mark the sweep incomplete and rescan
  with an overlap window; never an incident by itself.
- Durable progress per operation: table of seen operation ids with first/last seen, last verified, attempts, cool-down; cursor = last fully
  completed sweep time plus an overlap window; every eligible operation is eventually revisited even while newer ones arrive.
- Bounded provider calls per run, bounded concurrency, provider-wide backoff after 429/5xx, incidents deduped by (operation id, failure category) and
  updated in place. Shares claims with the checkout-recovery worker through the existing row locks.

**Extra tests for v3:** £5 payment vs £50 plan; several PayPal captures under one order; ledger-attributed-but-unfulfilled payment; missed Stripe refund
webhook caught by history sync; open dispute; refund of a base prepaid term with later paid extensions; identity-conflict replay; outbox retry after
crash; attested-mode audit and gating.

**Decisions on v2 open questions (from review):** no hidden override (see A5(c) for the only gated one); refuse payments older than 90 days by the
provider's capture date; keep refusing a live recurring agreement for the same lane; existing refund/dispute handling does NOT find these purchases
today, so A2/A4 are mandatory before enabling.

## 0. Rule of the system
Payments are fully automatic. The only manual money action is: a customer paid outside the portal directly in Stripe or PayPal, and the
operator links that payment by its provider ID. Money is at stake: refuse rather than guess. No amount, currency or "payment received"
claim is ever typed in by the operator; all of it comes from the provider.

## 1. Facts this builds on (verified in code)
- Ledger `payment_history_transactions`, written only via `provider-financial-state.recordTransaction()`: upsert unique on
  (provider, provider_transaction_id). It uses the shared `query`, not a transaction client. An upsert is not a one-time fulfilment claim.
- `lifecycle-primitives.activatePurchase` locks the customer row, checks payment-linked subscriptions / access extensions and recorded
  money loss. `subscription-access-extensions.js` serialises per subscription and tracks purchased days per payment.
- Stripe identities differ by path: checkout uses the PaymentIntent id; history sync keys the ledger by balance-transaction id.
- PayPal: capture is the money identity (`getCapture`, `recordCompletedCapture`), the order id is an alias.
- `manual_payment_events` is a cash/bank NOTE ledger, no access effect; it stays, relabelled "Note a cash/bank payment".
- Customer attribution by email exists for reporting only (`provider-financial-state.resolveCustomerId`). It is NOT sufficient to authorise access.

## 2. Feature A: record an external payment

### 2.1 Fulfilment record (the one durable identity)
New table `external_payment_fulfilments`:
`id, provider, canonical_payment_id, alias_ids text[], merchant_account (Stripe account id / PayPal client+env), customer_id, plan_id,
service_lane, subscription_id, ledger_provider_transaction_id, verified_amount_minor, verified_currency, evidence_fingerprint,
submission_id (unique), state ('applied'|'reversed'), recorded_by, created_at, reversed_at, reversal_reason`.
Unique on (provider, merchant_account, canonical_payment_id) AND a unique index over every alias (separate alias table or a partial unique
per alias) so the same money cannot be claimed through a different reference.
- Canonical id: Stripe = PaymentIntent (aliases: charge id, balance transaction id, invoice id). PayPal = capture id (alias: order id).
  An order id alone is refused (no proof of capture).
- Before anything: reject if ANY alias exists in `external_payment_fulfilments`, in `payment_history_transactions` with a customer / local
  subscription effect, or in `checkout_intents` (portal payment → refer the operator to the existing confirm/recovery action).

### 2.2 Operator flow
Customer page → Payments card → "Record a payment made outside the app": provider, payment ID, plan, optional note → "Look up payment"
(read-only preview from the provider: amount, currency, status, date, payer, refunded/disputed amounts, plan price, ownership evidence,
exactly what access will result) → "Record and activate".

### 2.3 Ownership (positive evidence required, no override in v1)
Allowed only if at least one holds, evaluated server-side from the provider record:
(a) the Stripe customer / PayPal payer id is already linked to THIS customer (existing provider identity), or
(b) the provider payment carries our customerId metadata for THIS customer, or
(c) the payer email equals this customer's account email exactly (case-insensitive) AND no other customer owns that email or that provider identity.
If the provider identity is linked to a DIFFERENT customer → refuse. If no evidence → refuse ("cannot prove this payment belongs to this
customer"); there is no operator override. (Decision for the owner: whether a later, separately reviewed owner-only override is wanted.)

### 2.4 Preview → confirm
Preview returns a signed token binding: provider, merchant account, canonical id, customer, plan, service lane, verified amount+currency,
evidence fingerprint, intended access effect, expiry (10 min), and a one-time submission id.
Confirm re-fetches from the provider with server credentials and refuses unless: payment is fully completed/captured, belongs to our merchant
account/environment, amount+currency equal the token, NO refund / reversal / dispute / chargeback (any amount) exists, and the evidence
fingerprint still matches. Then it takes the fulfilment lock (see 2.5) and re-checks everything local. Provider unreachable, rate-limited or
ambiguous → nothing is written; the operator sees "try again".

### 2.5 Atomic apply (one transaction)
1. Lock customer row (same lock `activatePurchase` uses).
2. Insert the fulfilment row (`ON CONFLICT DO NOTHING`; zero rows inserted = already applied → return the original outcome, change nothing).
3. Write the ledger row with a NEW transaction-aware `recordTransaction(input, client)` (metadata: `source:'operator_recorded'`, recordedBy, fulfilment id).
4. Apply the access effect (2.6) in the same transaction.
5. Insert `audit_log` (`admin.payment.external_recorded`) with provider, ids, amount, plan, effect, operator.
Crash anywhere → the whole transaction rolls back; a retry re-verifies and starts again. Response lost after commit → resubmitting returns the
stored outcome (keyed by submission_id / canonical id). Webhooks, the history sync and checkout recovery that later see the same payment hit
the same unique ids and the existing idempotent upserts; they cannot create a second grant because step 2 already claimed it, and they must
check the fulfilment table before applying.

### 2.6 Access effect (explicit, v1 conservative)
Per customer + service lane, evaluated under the lock:
- Live Stripe/PayPal recurring agreement for that lane → REFUSE (no overlapping or hidden credit in v1). Never touch the provider link.
- Live prepaid term (Plisio / earlier external payment), same plan and service → EXTEND via the existing access-extension mechanism: paid-through
  moves forward by the plan duration, recomputed under the subscription lock; never overwritten by now + duration.
- Live term on a different plan → REFUSE (needs the existing plan-change flow).
- No live term → ONE new one-off subscription (`billing_mode='payment'`, source = provider, no provider subscription id), period = plan duration.
Capacity, Stremio acquirability and recorded-loss checks from `activatePurchase` still apply.

### 2.7 Refund / dispute / reversal
The fulfilment row stores the ledger transaction so the existing refund and dispute handling (webhooks, history sync, operator refund) can
recognise the purchase. Required behaviour, to be proven by tests before build is declared done: a refund or dispute arriving at any time
(before, during or after confirm) marks the fulfilment `reversed` and removes only that purchase's contribution to paid-through access
(recompute from remaining purchases; never destroy time bought by other payments); a dispute opened later reverses the same way.
No "undo" button: reversal is the existing refund flow. A reversed payment id can never be recorded again.

### 2.8 Notifications, permissions, audit
- One `payment.received` customer notification after commit (default on; operator checkbox "do not email customer"), deduped by fulfilment id.
- Admin-only, CSRF, write rate limit. Audit EVERY preview, refusal (with reason code) and confirm; never store secrets or raw provider payloads.
- Plain-language refusal reasons; the preview page shows exactly why it would be refused.

## 3. Feature B: automatic Plisio sweep

### 3.1 Production evidence (plisio:list-shape at ca0308fb)
`_meta.totalCount=4` (all completed, 3 invoices) yet every request returned 0 items; every request sent page=1 and Plisio answered
`currentPage=2` → `page` is zero-based on this account; `limit` is honoured (`perPage=5`), `per-page` is ignored. Plisio's public docs do not say
zero-based, so the contract is established empirically and then guarded.

### 3.2 Behaviour
- A persistent cursor + bounded run: up to N requests per run (e.g. 10), `page=0` first, `limit=50`, advancing; overlapping rescan of the newest
  page each run because offset paging shifts when new operations arrive.
- Contract guard each response: `_meta.currentPage == requestedPage+1`; items.length matches min(perPage, remaining totalCount); unique
  operation ids across pages; items collected ≥ expected total at the end. Any violation → stop, record ONE deduped "provider contract changed"
  incident, do not mark the sweep complete. A first sweep with totalCount>0 and zero items found is always a violation.
- The list is only a discovery hint. For each operation not already settled locally, run the existing per-ID verification (`confirmCheckout`),
  never granting from list data. 429/5xx → backoff with jitter and resume next run.
- Cooperates with the existing 5-minute checkout recovery through the same row locks: both end in the idempotent per-ID path, so there is no second
  grant. Fair scheduling: oldest-unchecked first with a per-operation attempt counter and cool-down so a poison row cannot starve the rest.
- Verified-evidence rule: amount/currency/status for any grant come from the per-ID provider response. `confirmCheckout`'s fallback to
  callback/intent values is labelled "contract value, not provider-verified"; when the provider response lacks amount/currency the operation is
  NOT granted by the sweep and goes to an incident instead.
- Completed at Plisio but matching no local intent → one "unmatched receipt" incident per operation (deduped by txn id), operator-visible, no grant.

## 4. Rollout
1. Ship the sweep in REPORT-ONLY mode (reads, matches, reports discrepancies and contract violations, grants nothing). Review real output.
2. Enable sweep verification (per-ID path) once the zero-based contract has run clean for a few days.
3. Ship the external-payment preview (read-only lookup + discrepancy) first, then the confirm step behind a setting limited to admins.
Rollback = disable entry points / setting; never delete financial evidence.

## 5. Test matrix (release gate)
Concurrent double confirm; confirm vs webhook; confirm vs history sync; confirm vs checkout recovery; wrong customer / other customer's
identity / ambiguous email; wrong merchant account or environment; amount or currency mismatch; refunded, partially refunded, disputed,
old refunded capture; recurring Stripe/PayPal present; Plisio prepaid stacking; different-plan refusal; crash after claim (rollback) and after
commit (replay returns the stored outcome); refund after record reverses only that purchase; Plisio page-zero vs page-one, empty page with
totalCount>0, repeated page, shifted pages, 429, poison row, hostile list data. Existing suites unchanged and green; no change to expiry, renewal
or refund behaviour for existing customers.

## 6. Open questions
1. Owner-only override for payments we cannot tie to the customer (default: none in v1)?
2. Refuse payments older than N days (suggest 90)?
3. Is refusing a live recurring agreement for the same lane too strict operationally, or is a separately modelled credit wanted later?
4. Does the existing refund/dispute handling reliably find an `operator_recorded` ledger row and its subscription? (Must be verified in code before build.)

## 7. Out of scope
Stripe `past_due` policy; late-retry recovery after local expiry; PayPal one-off polling.
