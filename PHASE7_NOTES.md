# Native Users + Servers administration notes

Production server administration uses an explicit Jellyfin hostname allowlist.

Set `JELLYFIN_ALLOWED_HOSTS` to the exact comma-separated internal/DNS hostnames that the application is permitted to use for Jellyfin base URLs. The application refuses server URL changes in production when the allowlist is absent or the requested hostname is not listed.

Example only:

```text
JELLYFIN_ALLOWED_HOSTS=jellyfin,premium-jellyfin,10.20.0.15
```

Do not list unrelated internal infrastructure.

Server API credentials are write-only in the UI, encrypted at rest, and validated against the selected Jellyfin endpoint before a new or rotated credential is stored. Server configuration writes and manual customer reconciliation both require the administrator's current second factor in addition to the authenticated admin session and CSRF token.

Destructive server deletion/hard-disable and arbitrary user deletion/toggle actions are intentionally outside this phase.
