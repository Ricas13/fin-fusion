# Version and update visibility

CAPTAiNFiN exposes the running application version and exact deployed Git revision under **Administration → Settings → System**.

The supported production deployment path embeds two immutable build values in the Docker image:

- `CAPTAINFIN_BUILD_SHA` — exact source commit used for the image.
- `CAPTAINFIN_BUILD_TIME` — UTC image build time.

The application version itself continues to come from `package.json`. The Git revision is the authoritative answer when two builds share the same semantic application version.

## Update checks

In production, authenticated admin pages can perform a server-side check against the public `main` branch of `Ricas13/fin-fusion`. The browser never talks directly to GitHub. The request uses CAPTAiNFiN's existing outbound URL safety policy and the result is cached for six hours.

The status intentionally distinguishes:

- **Up to date** — deployed commit and current `main` are identical.
- **Update available** — `main` is ahead of the deployed commit.
- **Custom build** — the deployed commit is ahead of or diverged from `main`; CAPTAiNFiN does not assume it should be replaced.
- **Build unknown** — the image was not built through a path that embedded an exact commit.
- **Check unavailable** — GitHub could not be verified at that time.

Set this in `.env` to keep local version/build visibility while disabling outbound update checks:

```env
CAPTAINFIN_UPDATE_CHECK_ENABLED=false
```

## Applying an update

The admin UI deliberately does not execute host commands. Run updates on the production host:

```bash
bash update.sh
```

That command keeps source update and deployment inside the existing SSH-safe flow, including clean-checkout protection, encrypted pre-deploy backup, migrations, container health checks and application-level verification.
