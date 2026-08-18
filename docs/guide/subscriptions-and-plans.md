# Subscriptions and plans

CAPTAiNFiN separates the **commercial plan** a customer buys from the **Jellyfin account** that delivers service.

## What a plan controls

Depending on the plan configuration, a plan can define:

- price and currency
- billing interval and access duration
- concurrent stream allowance
- download permission
- transcoding and remuxing policy
- Live TV permissions
- 4K access
- eligible Jellyfin server class and placement rules
- libraries the customer can access

## Existing subscriptions and plan edits

Changing a catalogue plan is intended to affect **future acquisition and renewal decisions**. CAPTAiNFiN keeps commercial snapshots on subscriptions and checkout contracts so an existing paid-through service period is not silently rewritten when an administrator edits the catalogue later.

Archiving a plan removes it from new catalogue acquisition without deleting historical subscription records.

## Concurrent streams

The stream limit is the number of simultaneous playback sessions allowed by the plan policy. A temporary account hold does not create an extra commercial entitlement.

## Future delivery types

CAPTAiNFiN is being prepared to support multiple delivery types:

- **Jellyfin** — normal Jellyfin portal/account access
- **Stremio** — stream-only access delivered through a user-specific Stremio addon credential
- **Bundle** — both Jellyfin and Stremio access

Stremio delivery is not live until the addon runtime and playback bridge are explicitly enabled in a later release.
