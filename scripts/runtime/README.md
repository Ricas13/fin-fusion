# Runtime scripts

Long-running production worker entrypoints belong here when a future change deliberately migrates their paths.

Existing worker paths remain stable for Compose/deployment compatibility. A runtime move must update Compose commands, health checks and deployment/recovery tests atomically.
