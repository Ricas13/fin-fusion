# Plisio crypto checkout

CAPTAiNFiN uses Plisio for **one-time crypto payments**. Crypto purchases receive the normal configured plan duration but do not auto-renew.

## Browser setup

Open **Commerce → Payments → Plisio** and save the Plisio merchant `SECRET_KEY`. Browser-managed credentials are encrypted with `DATA_ENCRYPTION_KEY`.

CAPTAiNFiN supplies its callback URL on every invoice. The callback is requested in Plisio JSON mode so the documented `verify_hash` HMAC can be verified deterministically.

For unattended deployments the optional environment fallback is:

```env
PLISIO_ENABLED=true
PLISIO_SECRET_KEY=
```

`PLISIO_API_KEY` is accepted as a compatibility alias for the secret key, but `PLISIO_SECRET_KEY` is the preferred name.

## Payment verification

A callback is never treated as proof of payment on its own. CAPTAiNFiN:

1. verifies the Plisio `verify_hash` with a timing-safe comparison;
2. binds `order_number` to the local checkout intent and `txn_id` to the provider checkout ID;
3. independently fetches `/api/v1/operations/{txn_id}` from Plisio;
4. requires the remote operation to reference the same local order;
5. checks the remote source fiat amount and currency against the immutable local commercial snapshot;
6. activates access only when Plisio reports `completed`;
7. processes repeated callbacks idempotently through the existing payment-event and checkout-intent lifecycle.

Pending payments keep the checkout open. Expired/cancelled/error/mismatch states never activate access.
