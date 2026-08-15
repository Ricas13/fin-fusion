# Troubleshooting and FAQ

## I see “Request failed.”

An unexpected server-side error reached the generic safety handler. Refresh once, note the page/action you were using, and contact the administrator if it repeats.

Administrators should use the application logs and request ID to locate the underlying exception. Avoid replacing the generic production error with raw database or stack-trace details in the browser.

## I cannot sign in

Check that you are using the correct portal for your account type and the correct portal password. Jellyfin credentials are separate and do not necessarily sign you into CAPTaINFiN.

If the account uses 2FA, use the current authenticator code or an unused recovery code. Repeated failed attempts may trigger a temporary rate limit.

## Password reset email does not arrive

Browser password reset depends on transactional email being configured. If email delivery is unavailable, contact the administrator rather than repeatedly requesting resets.

## Jellyfin password does not match my portal password

This is expected. CAPTaINFiN intentionally separates portal credentials from Jellyfin credentials. Use the Jellyfin password setup/change action provided in your account portal.

## My libraries are missing

Library visibility is constrained by the active plan and by the customer's allowed selection. A customer cannot select a library the plan does not entitle.

Administrators should also confirm that the assigned Jellyfin server exposes the expected library and that provisioning reconciliation is healthy.

## A reseller cannot add another customer

Check the reseller subscription state and seat usage. A temporary suspension/hold does not release the commercial seat; end an unused downstream service or move the reseller to a tier with more capacity.

## A server is unavailable for placement

Check that it is enabled, healthy, in the correct server class, below configured capacity, and eligible for the selected plan. Also verify its internal base URL and API credentials.

## Stremio does not appear for customers

The Stremio work in the current foundation release is not a production addon. Server eligibility, delivery types and entitlement storage can be prepared, but customer installation/playback should not be expected until the dedicated addon runtime is released.

## Where can I get help?

Use the support contact configured by the administrator. Never send passwords, 2FA recovery codes, Jellyfin API keys or payment-provider secrets in a support message.
