# Getting started

CAPTAiNFiN has separate areas for customers and administrators. Sign in with the account type you were given and use the navigation for your role.

## Customers

A customer can use the portal to review service status, manage account security, set a separate Jellyfin password when required, adjust allowed library visibility, configure Stremio when included, and access payment/subscription actions made available by the active plan.

## Administrators

Administrators configure the platform itself: plans, servers, libraries, commerce, automation, security and system settings.

The admin interface groups controls by purpose. Each important setting includes a short explanation of what it changes; deeper topics are documented in the Administrator section of this guide.

## Passwords

CAPTAiNFiN portal passwords and Jellyfin passwords are separate. A portal password reset does not silently change the Jellyfin password.

## If something fails

For a normal validation error, the platform should explain what needs to be corrected. For an unexpected server error, note what page/action you were using and contact the administrator. Administrators can use the application request ID and logs to locate the underlying exception.

## Stremio service

When a plan includes Stremio, the customer can create a private installation link from the portal. Managed CAPTAiNFiN Jellyfin delivery and any configured external sources are presented as source-neutral Stremio results; customers should not need to understand the internal source topology.
