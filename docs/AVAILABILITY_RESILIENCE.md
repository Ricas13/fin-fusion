# CAPTAiNFiN availability resilience

CAPTAiNFiN is a revenue-facing portal. Availability policy therefore follows one rule: **non-critical work must fail before the storefront, login, checkout, webhooks, renewals or customer access control fail.**

This document separates same-host self-healing from true infrastructure high availability. Docker restart policies and backups are useful, but neither is a substitute for another live web/database path when an entire host is unavailable.

## Availability layers

### Layer 1 — request/process containment

Current controls:

- `/health/live` is database-independent process liveness.
- `/health/ready` checks the database, migrations and runtime settings.
- readiness has a bounded deadline so health probes return `503` rather than hanging indefinitely when the application database path is saturated.
- web database connection acquisition is bounded independently from PostgreSQL's server-side statement timeout.
- provider HTTP calls have explicit deadlines.
- graceful shutdown drains in-flight HTTP requests.
- app, automation, activity and backup containers have explicit process/resource boundaries.

Target: an isolated bad request, external provider, maintenance job or exhausted pool must degrade/fail quickly without consuming the whole web process indefinitely.

### Layer 2 — same-host automatic recovery

`scripts/availability-watchdog.sh` is the independent host-level recovery loop. It is intentionally outside the Node container so it can detect a dead or wedged event loop.

It performs conservative recovery:

1. If the web container is missing/stopped, ask Compose to start it.
2. If `/health/live` fails repeatedly, restart the web app.
3. If `/health/ready` fails but PostgreSQL is healthy, recycle the web app after a bounded threshold/cooldown.
4. If PostgreSQL is stopped/exited, start the existing database container/volume, wait for health, then recycle the web connection pool.
5. If PostgreSQL is **running but unhealthy**, do **not** blindly restart it. Preserve the failure state for diagnosis rather than risk a destructive DB restart loop.
6. If the backup worker is unhealthy during a storefront readiness incident, stop the backup worker first. Backups are important, but they are not allowed to consume the live portal's availability budget.
7. Every automatic web restart is protected by a cooldown to prevent restart storms.

Install the watchdog on a systemd host:

```bash
cd /opt/captainfin-store
bash scripts/install-availability-watchdog.sh
```

Check it with:

```bash
systemctl status captainfin-availability-watchdog.timer
journalctl -u captainfin-availability-watchdog.service --since '1 hour ago'
tail -n 200 logs/availability-watchdog.log
```

The default timer runs every 30 seconds. It should run as the same deployment user that already has Docker access, not as an application container with the Docker socket mounted.

### Layer 3 — same-host web redundancy

**Not yet satisfied by the current Compose topology.** There is still one revenue-facing web container bound to `127.0.0.1:3030`.

The next topology should put a small local gateway in front of at least two stateless web replicas. Both replicas can share PostgreSQL-backed sessions and database state. The gateway must retry/fail over on connection errors, timeouts and `502/503/504`, while the existing public HTTPS reverse proxy continues to target only localhost.

This layer protects against:

- one Node process crashing;
- one web container hanging;
- one web release instance failing readiness;
- a single process memory leak;
- rolling application restarts.

It does **not** protect against PostgreSQL or whole-host failure.

### Layer 4 — database high availability

**Not satisfied by the local single-container PostgreSQL topology.** The current database has container restart protection and encrypted backups, but the named Docker volume and database server are still a single live failure domain.

For a revenue-critical deployment, production should use either:

- a managed PostgreSQL service with automatic primary failover; or
- a primary plus continuously streaming standby on a different host, with a tested automated promotion/failover mechanism.

Application runtime URLs already support PostgreSQL URLs/TLS, but the Compose/deployment topology still assumes the bundled local `postgres` service and must be adapted before an external HA database becomes the supported production path.

A daily backup is disaster recovery, not high availability. Streaming replication/WAL continuity is what closes the data-loss window between backups.

### Layer 5 — whole-host/origin failover

**Not satisfied by a single VPS.** If the host loses power, storage, Docker, networking or its provider has an outage, every container on that machine is unavailable at once.

The target architecture is two independent origins:

- primary application host;
- secondary application host in a different failure domain;
- both pointed at the HA PostgreSQL service;
- encrypted configuration/secrets replicated securely;
- public traffic fronted by an external health-checked load balancer/CDN that removes an unhealthy origin automatically.

The secondary origin should already be running and healthy. A backup that must first be restored onto a new VPS is the final disaster-recovery layer, not the normal failover path.

### Layer 6 — external availability monitoring

Monitoring must come from outside the CAPTaINFiN host. A process on the same VPS cannot report that the VPS itself is unreachable.

At minimum monitor:

- public `/health/ready` through the real HTTPS hostname;
- public storefront page;
- customer login page;
- one synthetic no-charge/read-only account journey;
- certificate expiry;
- DNS/public origin reachability.

Alert independently of CAPTaINFiN email/Discord delivery so a portal outage cannot also suppress its own alert.

## Resource isolation

Compose gives explicit CPU/memory/PID ceilings to the long-running web and worker services. The defaults are intentionally generous for the web process and tighter for non-critical maintenance. They are caps, not reservations.

The backup worker has the smallest CPU budget because backup/verification is allowed to take longer; it is never allowed to win a resource fight against checkout/login/storefront traffic.

Tune through environment variables only after observing real production usage:

```text
APP_MEMORY_LIMIT / APP_CPU_LIMIT / APP_PIDS_LIMIT
AUTOMATION_MEMORY_LIMIT / AUTOMATION_CPU_LIMIT / AUTOMATION_PIDS_LIMIT
ACTIVITY_MEMORY_LIMIT / ACTIVITY_CPU_LIMIT / ACTIVITY_PIDS_LIMIT
BACKUP_MEMORY_LIMIT / BACKUP_CPU_LIMIT / BACKUP_PIDS_LIMIT
```

Database wait controls:

```text
APP_DB_CONNECTION_TIMEOUT_MS
APP_DB_QUERY_TIMEOUT_MS
AUTOMATION_DB_CONNECTION_TIMEOUT_MS
AUTOMATION_DB_QUERY_TIMEOUT_MS
ACTIVITY_DB_CONNECTION_TIMEOUT_MS
ACTIVITY_DB_QUERY_TIMEOUT_MS
BACKUP_DB_CONNECTION_TIMEOUT_MS
BACKUP_DB_QUERY_TIMEOUT_MS
READINESS_TIMEOUT_MS
```

`READINESS_TIMEOUT_MS` must remain below the Docker healthcheck timeout so a bad dependency produces an explicit `503` response rather than an abandoned/hanging probe.

## Deployment availability

The current safe deployment path intentionally drains the single application/worker runtime before migrations. This prevents old-code/new-schema write races, but it also means schema-changing releases have an intentional availability gap.

A future zero/near-zero-downtime deployment path needs both:

1. redundant web replicas behind a local gateway; and
2. a migration policy that distinguishes backward-compatible expand migrations from destructive/contract migrations.

Without that schema compatibility discipline, keeping old and new application versions writing concurrently is more dangerous than a short controlled drain.

## Backups and disaster recovery

Encrypted scheduled backups, restore verification and optional off-site copies remain required even after HA is added. HA protects availability; backups protect against accidental deletion, corruption, bad migrations and operator mistakes that can replicate to every live database node.

For production:

- configure off-site backup storage;
- keep restore verification enabled;
- periodically perform a recovery drill onto a clean database;
- monitor backup age and verification age externally;
- retain at least one backup outside the primary hosting provider/failure domain.

## Current risk summary

After the same-host hardening in this branch:

- **web process/container crash:** self-healing path exists;
- **wedged app / healthy DB:** self-healing path exists;
- **stopped local PostgreSQL container:** conservative automatic start path exists;
- **unhealthy maintenance worker starving storefront:** backup circuit breaker exists;
- **slow/saturated DB path:** bounded failure rather than indefinite health hangs;
- **single web container:** still a single live web failure domain until Layer 3;
- **single PostgreSQL server/volume:** still a critical live failure domain until Layer 4;
- **single VPS/network/provider:** still a critical live failure domain until Layer 5;
- **no external monitor:** host outage can remain invisible until a customer reports it unless Layer 6 is configured.

The resilience goal is not "nothing can ever fail." The goal is that every individual failure has a smaller blast radius, an automatic next path where it is safe to automate one, and a tested recovery path where automatic action would be dangerous.
