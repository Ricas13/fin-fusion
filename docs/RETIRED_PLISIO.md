# Plisio retirement

Plisio (one-time crypto checkout) is no longer supported. The application no longer creates Plisio
invoices, accepts `/webhooks/plisio` callbacks, calls the Plisio API, runs the Plisio payment sweep,
or offers Plisio in the storefront, checkout, admin payment settings or Connections overview.

What was deliberately kept, so existing customers and accounting are not harmed:

- Historical `plisio` rows (subscriptions, checkout intents, payment events, incidents and ledger
  transactions) are untouched. Paid time already bought through Plisio keeps working and still
  appears in Orders, Transactions and the customer billing history.
- The database provider constraints and prepaid-time functions still accept `plisio` as a read-only
  historical value, so no destructive data rewrite is needed.
- Administrators can still record an out-of-app refund for a plan paid through Plisio.
- Moving paid value away from a Plisio purchase is refused, because the original payment can no longer
  be verified with the provider.

Migration `20261128170000_retire_plisio_gateway.sql` removes any stored Plisio merchant secret.
Remove `PLISIO_ENABLED` and `PLISIO_SECRET_KEY` from your environment; they are now ignored.
