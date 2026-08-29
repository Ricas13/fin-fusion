# Troubleshooting and FAQ

## I see “Request failed.”

An unexpected server-side error reached the generic safety handler. Refresh once, note the page/action you were using, and contact the administrator if it repeats.

Administrators should use the application logs and request ID to locate the underlying exception. Avoid replacing the generic production error with raw database or stack-trace details in the browser.

## I cannot sign in

Check that you are using the correct portal for your account type and the correct portal password. Jellyfin credentials are separate and do not necessarily sign you into CAPTAiNFiN.

If the account uses 2FA, use the current authenticator code or an unused recovery code. Repeated failed attempts may trigger a temporary rate limit.

## Password reset email does not arrive

Browser password reset depends on transactional email being configured. If email delivery is unavailable, contact the administrator rather than repeatedly requesting resets.

## Jellyfin password does not match my portal password

This is expected. CAPTAiNFiN intentionally separates portal credentials from Jellyfin credentials. Use the Jellyfin password setup/change action provided in your account portal.

## My libraries are missing

Library visibility is constrained by the active plan and by the customer's allowed selection. A customer cannot select a library the plan does not entitle.

Administrators should also confirm that the assigned Jellyfin server exposes the expected library and that provisioning reconciliation is healthy.

## How do prepaid top-ups work?

Prepaid purchases can be added before your current access expires. New prepaid time is added after the access you have already paid for, so buying early does not discard the remaining time on your account.

For example, if your access is paid through 30 September and you buy another month, the additional month starts after that paid-through date rather than replacing it.

## How do refunds work for prepaid plans?

A prepaid period that has not started can be fully refunded and removed from your future paid access where the payment is eligible for a refund. If later prepaid periods are already queued, they move forward so removing the refunded period does not create an unnecessary gap.

Once a prepaid period has started, any voluntary refund is normally limited to the unused portion of that prepaid service. The calculation is based on the remaining service time and the money actually paid through the payment provider. Affiliate or service credit is not cash and cannot be converted into a cash refund.

For example, if half of an annual prepaid period remains, a voluntary refund would normally be limited to approximately half of the refundable cash value of that purchase. Exact calculations may differ slightly because they use the actual service dates and are rounded to the payment currency.

Refund eligibility can still depend on the circumstances of the purchase and applicable consumer rights. Contact support before assuming a particular refund amount is available.

## What happens if I dispute or charge back a payment?

A bank or payment-provider dispute is different from asking support for a voluntary refund. The bank or payment provider controls the amount and outcome of a dispute; CAPTAiNFiN does not reduce a dispute simply because part of the service period has already been used.

While a dispute or chargeback is being reviewed, access may be restricted according to the service's payment-risk policy. Service and payment records may be used as evidence that access was supplied. When the payment provider reaches an outcome, account access and paid entitlement are reconciled to that outcome.

If you have a billing problem, contact support first where possible so the available refund or account options can be reviewed before opening a payment dispute.

## A server is unavailable for placement

Check that it is enabled, healthy, in the correct server class, below configured capacity, and eligible for the selected plan. Also verify its internal base URL and API credentials.

## Stremio does not appear for customers

The Stremio work in the current foundation release is not a production addon. Server eligibility, delivery types and entitlement storage can be prepared, but customer installation/playback should not be expected until the dedicated addon runtime is released.

## Where can I get help?

Use the support contact configured by the administrator. Never send passwords, 2FA recovery codes, Jellyfin API keys or payment-provider secrets in a support message.
