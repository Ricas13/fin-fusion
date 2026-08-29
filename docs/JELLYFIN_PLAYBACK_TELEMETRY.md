# Jellyfin playback telemetry

CAPTAiNFiN does not treat playback telemetry as second-accurate billing data. The `/Sessions` poll remains the safety net and the optional Jellyfin Webhook plugin reduces the chance of missing short plays.

## Polling and inactivity trust

The activity worker polls managed Jellyfin servers every `STREAM_POLICY_POLL_SECONDS` (20 seconds by default, 15 seconds minimum). After each completed activity cycle it records the latest attempt and per-server success/failure in `jellyfin_activity_poll_state`.

A Free Server inactivity action is allowed only when:

- the activity worker heartbeat is less than 120 seconds old; and
- that customer's Free Server latest poll attempt succeeded; and
- that success is no older than `STREAM_POLICY_POLL_SECONDS + STREAM_POLICY_POLL_SLACK_SECONDS`.

A failed Free Server poll therefore defers only accounts on that server. An unrelated Premium server failure does not gate Free Server inactivity.

When a session disappears from `/Sessions`, the existing `STREAM_POLICY_GRACE_SECONDS` applies before the active row is closed. The history row closes at the last timestamp Jellyfin actually reported, rather than adding the grace period to watched time.

## Jellyfin Webhook plugin

The application already owns the webhook surface. Configure one Jellyfin Webhook plugin **Generic Destination** per managed server.

- URL: `https://<captainfin-host>/webhooks/jellyfin/<server-id>`
- Request header: `X-Fin-Fusion-Webhook-Secret: <same value as JELLYFIN_WEBHOOK_SECRET>`
- Notification types: **Playback Start**, **Playback Progress**, **Playback Stop**
- Enable **Send All Properties (ignores template)** so the standard playback fields are sent without maintaining a second template schema.
- Content type: JSON

`<server-id>` is the CAPTAiNFiN `jellyfin_servers.id` UUID for that Jellyfin instance, not Jellyfin's display name.

The ingest recognises `NotificationType`, `UtcTimestamp`, `UserId`, `ItemId`, `Name`, `ItemType`, `DeviceName`, `ClientName`, `PlayMethod`, `PlaybackPositionTicks` and `IsPaused`. On Start/Progress it also asks Jellyfin for the live `/Sessions` record when available, so it can use the same Jellyfin session ID and `playback_key` as the poller. Stop closes the matching history row with `COALESCE(ended_at, event_time)`, so a later duplicate Stop or poll close does not add the duration twice.

Paused playback still updates the recorded last-seen timestamp and Jellyfin account activity timestamp. `STREAM_POLICY_COUNT_PAUSED` continues to control concurrent-stream counting only; it does not decide whether paused playback proves recent presence.

## Customer-facing accuracy

The Free Server usage card intentionally says:

> Based on what the server reported. Short clips under ~30s may not appear.

With webhook ingest configured, a 10–20 second play can be recorded from Start/Stop even when it falls entirely between polls. Without a working webhook, the UI does not claim that such a clip must appear.
