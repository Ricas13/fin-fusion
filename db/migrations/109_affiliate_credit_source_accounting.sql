-- Forward-only service-credit provenance and explicit affiliate recovery state.
--
-- Accounting invariant (per customer/currency):
--   positive available grants + signed available adjustments
--   - explicit reversal debits - redemption debits
--   = ledger service credit before live checkout reservations.
-- Recoverable value from already-delivered service is kept outside that balance.

CREATE TABLE IF NOT EXISTS affiliate_credit_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    debit_ledger_id UUID NOT NULL REFERENCES affiliate_credit_ledger(id) ON DELETE CASCADE,
    grant_ledger_id UUID NOT NULL REFERENCES affiliate_credit_ledger(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(debit_ledger_id, grant_ledger_id)
);

CREATE INDEX IF NOT EXISTS affiliate_credit_allocations_grant_idx
    ON affiliate_credit_allocations(grant_ledger_id);
CREATE INDEX IF NOT EXISTS affiliate_credit_allocations_customer_currency_idx
    ON affiliate_credit_allocations(customer_id,currency);

CREATE TABLE IF NOT EXISTS affiliate_credit_recoveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    source_reward_id UUID NOT NULL REFERENCES affiliate_credit_ledger(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    recovered_minor INTEGER NOT NULL DEFAULT 0 CHECK (recovered_minor >= 0),
    reason TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_reward_id),
    CHECK (recovered_minor <= amount_minor)
);

CREATE INDEX IF NOT EXISTS affiliate_credit_recoveries_customer_currency_idx
    ON affiliate_credit_recoveries(customer_id,currency);

-- Repair the legacy double-removal shape. Old reverseReward() voided the original
-- earned row and also inserted an explicit negative reversal. Restoring only that
-- earned row makes the retained debit the single economic removal. Source-linked
-- top-up adjustments are intentionally left as their historical void rows: the old
-- implementation removed those only by voiding them and did not include them in its
-- reversal debit, so restoring them would manufacture credit.
UPDATE affiliate_credit_ledger earned
SET state = CASE
        WHEN earned.available_at IS NOT NULL AND earned.available_at > NOW() THEN 'pending'
        ELSE 'available'
    END,
    note = earned.note || ' · legacy double-reversal repair: grant restored; explicit reversal retained'
WHERE earned.entry_type='earned'
  AND earned.state='void'
  AND EXISTS (
      SELECT 1
      FROM affiliate_credit_ledger reversal
      WHERE reversal.entry_type='reversed'
        AND reversal.state<>'void'
        AND reversal.referral_redemption_id=earned.referral_redemption_id
        AND reversal.amount_minor<0
        AND (
            reversal.metadata->>'earnedCreditId'=earned.id::text
            OR reversal.reference_id='affiliate-reversal:'||earned.referral_redemption_id::text
        )
  );
