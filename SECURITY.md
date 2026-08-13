# Security

Steam Fusion manages reseller accounts and Jellyfin user access. Treat the application, its database, session secret and Jellyfin API key as privileged infrastructure.

## Production baseline

Run the application through `npm start` / `secure-start.js`. Do not launch the legacy `app.js` directly in production.

Before startup, configure:

- `NODE_ENV=production`
- `JELLYFIN_URL`
- `JELLYFIN_API_KEY`
- a unique `SESSION_SECRET` of at least 32 random characters
- `ADMIN_USERNAME`
- an `ADMIN_PASSWORD` of at least 12 characters for initial bootstrap
- `COOKIE_SECURE=true` when served through HTTPS

The secure bootstrap refuses known placeholder secrets and the legacy `admin/admin123` account.

## Credential handling

Jellyfin client passwords are one-time credentials. They may be returned immediately after creating or resetting an account, but the security layer removes them from the persistent JSON database and redacts them from general API responses, rendered template locals and backup payloads.

If upgrading an existing installation, users whose historic plaintext password is removed will need a password reset if the credential must be shared again.

## Reverse proxy

The application trusts one reverse proxy hop. Deploy it behind a controlled reverse proxy such as Traefik and do not expose the Node.js listener directly to the public internet.

## Transitional limitations

The current architecture still uses `express-session` MemoryStore and a JSON data file. Those are intentionally marked transitional. The next architecture phase moves persistent application data to PostgreSQL and sessions/rate-limit state to Redis-compatible storage.

## Reporting vulnerabilities

Do not publish credentials, API keys, session cookies, database backups or user data in a public issue. Rotate any secret that may have been exposed before debugging it further.
