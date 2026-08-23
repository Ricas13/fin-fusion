# CoinGate crypto payments

CAPTAiNFiN supports CoinGate as a hosted **one-time crypto checkout** provider. The customer is charged the plan price in the portal currency and CoinGate handles the cryptocurrency selection/payment experience.

## Behaviour

- CoinGate is available for paid direct-customer plans that have an active price in the platform portal currency.
- No `plan_provider_prices` mapping is required. CAPTAiNFiN creates a CoinGate order dynamically from the immutable local plan-price contract.
- CoinGate checkout is one-time only. A monthly, six-month or yearly plan receives its normal access duration, but CoinGate does not create an automatically renewing CAPTAiNFiN subscription.
- Discount codes are calculated locally before the CoinGate order is created. The discount reservation is kept for the longer hosted-crypto checkout window and the paid CoinGate order amount/currency must match the immutable local contract before access is activated.
- Mixed service-credit + CoinGate checkout is intentionally disabled. CoinGate confirmation can outlive a normal credit reservation, so allowing a partial credit reservation to expire while crypto is still confirming could make the same credit spendable twice. Customers can use full service credit when their balance covers the plan, or pay the CoinGate amount without mixed service credit.
- Access is activated only after CoinGate reports the remote order as `paid` and CAPTAiNFiN independently re-fetches that order through the authenticated CoinGate API.
- `new`, `pending` and `confirming` remain waiting states. `expired`/`canceled` close the checkout, and `invalid` fails it.
- Refund callbacks are recorded in the normal payment-risk incident system. Full refunds also revisit any qualifying affiliate reward.

## Recommended browser setup

1. Create/open a CoinGate API App.
2. Start with **Sandbox** and copy its API token.
3. In CAPTAiNFiN open **Administration → Commerce → Payments → CoinGate**.
4. Select Sandbox, paste the API token, enable the gateway and save.
5. CAPTAiNFiN generates a private callback verifier internally. There is no webhook signing secret or Webhook ID for the administrator to paste.
6. Use **Test connection**.
7. Run a small Sandbox checkout and confirm a successful callback appears in Recent provider events before moving to Live.
8. When going live, switch to Live and replace the token with the separate Live CoinGate API token.

CAPTAiNFiN supplies `/webhooks/coingate` as the `callback_url` on every CoinGate order. The callback handler accepts both JSON and form-urlencoded callbacks; JSON is preferred.

## Callback verification

CoinGate callbacks are treated as notifications, not as sufficient proof of payment. CAPTAiNFiN performs all of the following before fulfilment:

1. Every order receives a checkout-specific HMAC token derived from a private installation callback secret.
2. The returned callback token is compared with a timing-safe comparison.
3. The callback CoinGate order ID must match the provider order attached to the local checkout intent.
4. CAPTAiNFiN re-fetches `/api/v2/orders/{id}` with the private CoinGate API token.
5. The remote merchant `order_id` must equal the local checkout-intent UUID.
6. The remote fiat amount and currency must match the immutable local commercial snapshot.
7. Only the remote `paid` state activates service.

This means a forged request to `/webhooks/coingate` cannot activate access merely by posting `status=paid`.

## Environment fallback

Browser-managed settings are preferred and are encrypted at rest. Unattended/environment configuration is also supported:

```env
COINGATE_ENV=sandbox
COINGATE_API_TOKEN=
COINGATE_CALLBACK_SECRET=
```

`COINGATE_CALLBACK_SECRET` must be a stable random value of at least 32 characters. Do not rotate it while CoinGate orders are still outstanding or their callbacks will no longer validate.

## CoinGate API details used

CAPTAiNFiN currently uses:

- `GET /v2/auth/test` to validate the API token.
- `POST /api/v2/orders` to create checkout orders.
- `GET /api/v2/orders/{id}` to independently verify callback/order state.
- `Authorization: Token <API_TOKEN>` for server-to-server API calls.

Sandbox and Live use different API hosts and separate credentials.
