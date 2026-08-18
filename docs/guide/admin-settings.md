# Settings explained

The Settings area controls platform-wide defaults and integrations. Settings are grouped by purpose so changing one area does not require understanding unrelated parts of the system.

## General

### Site name

The customer-facing name used in page titles, portal branding and generated communication.

### Publish public storefront

Controls whether the public sales homepage is visible. Turning it off does not disable administrator or customer portals.

### Public registration

Allows visitors to create a customer portal account without an invitation. Invitations and administrator-created accounts can still work while public registration is closed.

### Require email verification

Requires new customer email ownership to be verified before normal sign-in. Only enable this when transactional email is configured and tested.

## Storefront

Storefront settings control public copy such as the hero title, subtitle, features, announcement and support address. Plan pricing is database-driven rather than typed into storefront copy.

## Admin defaults

Defaults are convenience values for administrator workflows. They are not a second policy engine and do not override an existing plan or subscription.

## Operations

Operations settings control deployment-wide behavior such as the canonical public URL and runtime safety settings. The public base URL should be the HTTPS address customers actually use to reach CAPTAiNFiN.

## Email

Transactional email is required for features such as email verification and browser-based password reset. Configure SMTP, test it, and only then enable workflows that depend on email delivery.

## Payments

Stripe and PayPal settings are kept separate from catalogue pricing. A plan can exist without a provider mapping, but hosted checkout requires an active and verified mapping for the selected payment provider.

## Backups

Backups protect the PostgreSQL database and configuration state. A backup being created is not the same as it being restorable; use the platform verification workflow to confirm backup integrity.

## Security

2FA is optional unless an administrator enables an enforcement policy. Customer portal passwords and Jellyfin passwords are separate credentials.
