# Admin audit review checklist

Before merge:

- Chromium authenticates through the real staff login.
- Every primary and discovered admin GET page returns successfully.
- Safe profile POSTs round-trip through CSRF/session handling.
- Global Notifications, My Profile and Provisioning workflow tabs remain stable.
- No document-level overflow at desktop/mobile audit viewports.
- Dashboard card rows do not leave obvious unused grid columns.
- Browser console/page errors and critical resource failures fail the audit.
- Screenshot/inventory artifact is uploaded for inspection.
- Existing security, lifecycle, clean-install and release-integrity workflows remain green.
