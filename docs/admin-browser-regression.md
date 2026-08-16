# Admin browser regression scope

The browser audit deliberately separates **navigation/rendering coverage** from **destructive integration execution**.

Chromium signs in through the real staff login, crawls every reachable `/admin` link plus the known primary and workflow destinations, and validates status, authentication continuity, page structure, console/page failures, document overflow and dashboard card-row coverage. It captures full-page desktop screenshots for the crawled surface and targeted mobile screenshots. It also submits safe personal email and reporting-currency forms to verify real CSRF/form routing.

The crawler does **not** blindly click controls that provision/delete users, create payments, send external messages, run full reconciliation, restore backups, invoke OAuth, or change remote Jellyfin state. Those actions require domain fixtures or external credentials and remain covered by their dedicated smoke/security/integration suites plus the static visible-action route integrity check.

The generated `admin-browser-audit` Actions artifact contains `inventory.json` and screenshots so layout regressions can be reviewed rather than inferred solely from HTML source.
