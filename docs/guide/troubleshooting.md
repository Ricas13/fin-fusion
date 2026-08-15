# Troubleshooting and FAQ

## I see `Request failed.`

This means the server encountered an unexpected error while handling the page or action. An administrator should use the request ID and server logs to find the underlying exception. The platform should not treat this message as a substitute for fixing the failed route.

## My Jellyfin password does not match my CAPTaINFiN password

This is expected. CAPTaINFiN portal credentials and Jellyfin credentials are intentionally separate.

## I cannot receive a verification or reset email

Transactional email must be configured and working before email-dependent workflows can complete. Contact the administrator if email delivery is unavailable.

## A service is paid but provisioning is pending

Commercial entitlement and Jellyfin provisioning are separate stages. A confirmed entitlement may remain pending while the platform waits for an eligible server or retries provisioning.

## Why is 2FA not required?

Two-factor authentication can be optional or mandatory depending on the policy configured for the account role.

## Why can I not use a private integration URL?

CAPTaINFiN blocks private and sensitive network destinations by default. Administrators must explicitly permit trusted private integrations.
