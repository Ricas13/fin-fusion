# Administrator Guide

The administrator portal is the control plane for CAPTaINFiN. Settings should be grouped by purpose and each control should explain its effect directly in the interface.

## Dashboard

Use the dashboard for service health, customer and reseller activity, commercial state and items requiring attention.

## Customers and users

Manage customer records, portal users, account state, provisioning and service access. Portal passwords and Jellyfin passwords are separate credentials.

## Resellers

Configure reseller defaults, tiers, seat capacity, billing state, downstream policy and reseller security. Defaults apply to newly-created resellers unless an individual override exists.

## Jellyfin servers

Add and manage Jellyfin servers, health, placement, libraries and provisioning. Server configuration determines where eligible customers can be placed.

## Plans and entitlements

Plans define commercial and service policy such as stream limits, library access and supported capabilities. Retiring a catalogue offer should not rewrite the terms of an already-committed paid subscription.

## Payments

Configure supported payment providers, mappings and commerce controls. Provider mappings should be verified before they are used for live checkout.

## Requests and integrations

Configure external request services and other integrations. Private-network integrations require explicit trusted-host or trusted-CIDR policy.

## Email and notifications

Transactional email is required for workflows that depend on email delivery, such as mandatory email verification or email password reset. Do not enable a required email workflow until delivery is configured and tested.

## Backups and recovery

Use the backup controls and verification workflow to create and validate recoverable database backups. Database restore is a privileged maintenance operation and should only be performed with a verified backup and an appropriate maintenance window.

## Automation

Automation workers maintain lifecycle, entitlement and supporting platform workflows. Review automation health if subscriptions, provisioning or scheduled tasks appear stale.

## Security

Two-factor authentication can be optional or enforced according to role policy. Use least-privilege service credentials and keep public and private integration policy explicit.

## Operations

Set the canonical public HTTPS URL used for externally-issued links and production readiness. Configure locale, timezone, session policy and trusted integration networks from the Operations area.
