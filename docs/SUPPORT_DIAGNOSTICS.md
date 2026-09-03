# System health and support diagnostics

CAPTAiNFiN exposes a read-only operator support centre under **Settings → System**.

The page brings together application readiness, database/migration state, worker health, backup recovery readiness, Jellyfin fleet state, integrations, notifications, live reconciliation pressure, durable recovery backlogs and the installed build/update status. Each health card links back to the existing canonical admin screen where the underlying issue can be reviewed.

## Operational pressure

The System page also exposes read-only counters from the owners that already enforce runtime correctness. It does not maintain a second metrics database.

- **Database pool** shows live PostgreSQL pool total, idle, waiting and configured maximum connections.
- **Reconciliation** shows process-local active/queued work, the configured concurrency limit, failures, lock timeouts and average slot/DB-lock timing collected by the canonical reconciliation gate.
- **Recovery backlog** counts durable payment-event retries, provider-operation recovery, provider operations requiring manual review, automatic paid-to-Free downgrade retries, and blocked/failed customer provisioning state.
- **Free downgrade due now** distinguishes automatic downgrade rows whose backoff has elapsed from the total durable retry backlog.

These counters are diagnostic only. They do not change queue ordering, retry policy or entitlement decisions.

Operational metric collection is deliberately best-effort so an optional counter cannot make **Settings → System** unavailable. A failed metric source is not silently ignored: CAPTAiNFiN logs a bounded warning and marks that metric group unavailable in the page/report rather than displaying a false healthy zero.

## Downloading a support report

Use **Download support report** on **Settings → System** to create a JSON diagnostic snapshot.

The report is intentionally allowlist-based. It includes operational facts that are useful when troubleshooting:

- CAPTAiNFiN version, deployed build and build time;
- Node.js and operating-system version/architecture;
- process uptime and rounded memory usage;
- application/database readiness and migration state;
- PostgreSQL version plus connection-pool counts;
- reconciliation active/queued/failure/timing counters;
- aggregate durable recovery backlog counts;
- worker heartbeat ages and error-state booleans;
- backup/recovery readiness states and recovery-point age;
- Jellyfin fleet counts, without server identities;
- notification queue counts;
- aggregate configuration issue counts by area/severity;
- a few security-posture booleans such as secure cookies and whether administrator 2FA is required.

## What the report does not include

The report does not include environment dumps, database connection strings, passwords, encryption keys, session secrets, provider/API credentials, webhook secrets, customer records, customer email/IP addresses, plan names, Jellyfin server names/URLs, provider operation identifiers, raw logs or raw operational error text.

Generation is protected by a second deny-on-leak sanitizer. It rejects sensitive-looking field names and values, including credential prefixes, PostgreSQL URLs, email addresses and IP addresses. It also checks the finished report against the explicitly known secret-bearing environment variables and refuses the download if a configured secret appears in the JSON.

This is defense in depth, not a substitute for operator judgment: **review the file before sharing** it outside your organisation.

## Security boundary

System diagnostics are read-only. The web application does not gain shell access, Docker socket access, `.env` file access, update execution or database-restore execution through this feature.

Host operations remain in the existing guarded tools:

- updates: `bash update.sh`
- backup/recovery: `bash recovery.sh ...`
- deployment verification: the existing production deployment/verification commands

The support report is intended to make remote troubleshooting easier without expanding those host-level privilege boundaries.
