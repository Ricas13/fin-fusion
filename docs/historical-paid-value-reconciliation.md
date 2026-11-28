# Historical paid-value reconciliation

Run `npm run billing:reconcile-paid-value -- --limit 500` against the intended database using a read-only account. Continue with `--after <nextAfter>` until nextAfter is null. Every page runs in a repeatable-read, read-only transaction. Run against a quiet snapshot for a consistent full report across pages. Protect the output: it contains internal subscription UUIDs and payment evidence.

The report separates verified remaining monetary value from ambiguous or unsupported entitlement histories. Currency totals are conservative per-record floors of exact fractions, not refunds or account balances. Never sum different currencies. No write, automatic cancellation, refund or entitlement change is performed. For cases requiring review, preserve the existing access and reconcile original provider payments and separately purchased extensions before any repair. This is an audit tool, not automatic historical remediation.
