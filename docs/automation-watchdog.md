# Independent automation watchdog

A green heartbeat is not enough to prove scheduler progress. Run the following
from the Docker host independently of the automation worker (for example from
your existing cron/monitoring system) once the app image containing this script
is deployed:

```sh
docker exec captainfin node scripts/automation-watchdog.js
```

The command uses the app's existing database role, opens a bounded read-only
snapshot, and writes one JSON result. Exit 0 = no critical finding (warnings
may exist); exit 2 = critical heartbeat/job finding; exit 3 = monitoring
failure. A missing container or nonzero shell exit is itself an alert.

Monitor nonzero exits and warning findings through an existing external alert
system; do not schedule this command as an automation-worker job. Use a
five-minute interval and deduplicate alerts in the monitoring system. Critical
jobs that are intentionally disableable are respected. A short restart grace
avoids false missing/overdue findings during startup.

Do not automatically kill/restart the worker based on this signal alone:
a provider request, refund, deletion or migration may still be in flight.
First check the worker logs, database lock ownership, and whether the job is
safe to interrupt or replay. This monitor never writes to the database, starts
jobs, or contacts providers. It reports health, not customer/payment data.
