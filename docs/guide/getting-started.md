# Getting started

CAPTaINFiN has separate areas for customers, resellers and administrators. Sign in with the account type you were given and use the navigation for your role.

## Customers

A customer can use the portal to review service status, manage account security, set a separate Jellyfin password when required, adjust allowed library visibility, and access payment/subscription actions made available by the active plan.

## Resellers

A reseller manages a downstream customer estate within the capacity of the reseller subscription. Seats represent active downstream entitlements; temporary suspension does not create extra capacity.

## Administrators

Administrators configure the platform itself: plans, servers, libraries, resellers, commerce, automation, security and system settings.

The admin interface groups controls by purpose. Each important setting includes a short explanation of what it changes; deeper topics are documented in the Administrator section of this guide.

## Passwords

CAPTaINFiN portal passwords and Jellyfin passwords are separate. A portal password reset does not silently change the Jellyfin password.

## If something fails

For a normal validation error, the platform should explain what needs to be corrected. For an unexpected server error, note what page/action you were using and contact the administrator. Administrators can use the application request ID and logs to locate the underlying exception.

## Planned Stremio service

Stremio support is being built as a stream-only delivery option backed by Jellyfin. It is not a live customer service until the addon runtime is released and explicitly enabled.
