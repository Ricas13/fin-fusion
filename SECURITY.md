# Security

CAPTAiNFiN manages customer identities, subscriptions, payment-provider configuration and access to Jellyfin/Stremio services. Treat the application, PostgreSQL database, encryption keys, session secret, provider credentials and Jellyfin credentials as privileged infrastructure.

## Supported production baseline

Use the supported deployment paths documented in `README.md` and `docs/PRODUCTION_DEPLOYMENT.md`:

- fresh install: `bash install.sh`
- normal update: `bash update.sh`
- lower-level production deployment: `bash scripts/deploy-production.sh`

The web application is intended to remain bound to localhost and sit behind a controlled HTTPS reverse proxy. Do not expose the Node.js listener directly to the public internet.

PostgreSQL is the authoritative datastore. Production sessions and persistent login-throttling state are PostgreSQL-backed; the original JSON datastore and in-memory session design are migration history, not the current production architecture.

Scheduled mutation work and playback/activity processing run in dedicated workers. Keep the purpose-specific runtime database roles and container isolation generated/configured by the supported deployment tooling rather than giving every process the web application's database credential.

## Secrets and credentials

Do not commit `.env`, database credentials, provider secrets, Jellyfin API credentials, session secrets, encryption keys, backup keys, recovery material or exported customer data.

Fresh installs generate independent high-entropy secrets. Do not reuse purpose-specific keys such as:

- `DATA_ENCRYPTION_KEY`
- `JELLYFIN_ENCRYPTION_KEY`
- `AUTH_ENCRYPTION_KEY`
- `ACTIVITY_ENCRYPTION_KEY`
- `BACKUP_ENCRYPTION_KEY`

Jellyfin, payment-provider, request-service and email credentials are encrypted at rest. Authentication/reset/claim/verification links store token hashes rather than reusable plaintext tokens. Passwords are stored as password hashes, not recoverable plaintext credentials.

If a secret may have been exposed, rotate or revoke it before continuing diagnosis. Do not paste live secrets into issues, pull requests, screenshots, logs or support conversations.

## Application security controls

The current security model includes:

- PostgreSQL-backed staff/customer identities and sessions
- persistent authentication throttling and abuse protection
- CSRF/origin protection for authenticated state-changing routes
- optional TOTP and recovery-code flows where configured
- signed/idempotent payment-provider webhook processing
- one-time activation, claim and reset flows
- encrypted sensitive configuration at rest
- purpose-specific database/runtime isolation for background workers
- audited privileged administration actions
- encrypted PostgreSQL backup and verification tooling

Security-sensitive behaviour is covered by the repository's CI, smoke/integration suites and CodeQL workflow. Do not bypass those checks when changing authentication, authorization, payment, provisioning, secret-handling, database or worker code.

For playback/activity-specific controls and worker isolation, see `ACTIVITY_SECURITY.md`.

## Reverse proxy and network boundaries

Terminate public HTTPS at a controlled reverse proxy and restrict direct access to application/database ports. Preserve the deployment's proxy/trust configuration rather than increasing the trusted-proxy range globally.

Jellyfin server destinations and other outbound integrations should remain constrained by the application's validation and outbound-policy controls. Avoid weakening hostname/URL validation to make an individual integration work.

## Reporting vulnerabilities

Do not disclose credentials, API keys, session cookies, database backups, customer data or exploitable vulnerability details in a public issue.

When possible, report security issues privately to the repository owner using GitHub's private security-reporting/advisory mechanism. Include the affected version or commit, impact, reproduction steps and any suggested mitigation, but redact live secrets and personal data.
