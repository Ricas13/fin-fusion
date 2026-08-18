# Invitation onboarding retirement

Invitation onboarding is no longer an active CAPTAiNFiN feature.

- New customer acquisition uses public registration when enabled, administrator-created customers, Jellyfin import/claim workflows and one-time activation links.
- `/invite/...` fails closed rather than redeeming historical invitation tokens.
- `/admin/invitations` redirects operators to customer management.
- Historical invitation migrations and database records are left intact where required for safe upgrades and audit history. They must not be reused to re-enable invitation onboarding.
