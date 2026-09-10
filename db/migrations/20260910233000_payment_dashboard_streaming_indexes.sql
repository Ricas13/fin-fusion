-- Dashboard accounting now keyset-scans live webhook fallback and imported
-- provider history in bounded pages. Match those cursor tuples directly so a
-- large accounting window does not require repeated sorts or table scans.
CREATE INDEX IF NOT EXISTS payment_events_dashboard_accounting_idx
    ON payment_events (created_at, provider, provider_event_id)
    WHERE provider IN ('stripe','paypal')
      AND processed_at IS NOT NULL
      AND processing_error IS NULL;

CREATE INDEX IF NOT EXISTS payment_history_dashboard_accounting_idx
    ON payment_history_transactions (occurred_at, provider, provider_transaction_id);
