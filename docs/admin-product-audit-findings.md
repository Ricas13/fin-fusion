# Initial admin audit findings

These are product/UX findings from the first structural pass before Chromium results are applied.

## Simplify

- **Policy Drift** is useful but too technical for a first-class sidebar slot. It is now a Provisioning workflow tab.
- **Notification gateway** is useful diagnostic information but duplicates the Notifications domain. It is now `Delivery health` inside global Notifications.
- **Events** is a historical cross-system audit timeline, not a dashboard task. It is renamed `Audit & events` and moved under Automation.
- **Settings → Commerce** remains removed because Commerce is already a primary navigation group.
- **My Notifications** remains a My Profile tab rather than a duplicate Settings destination.

## Keep

- **Needs Attention** remains first-class because it is explicitly actionable rather than merely diagnostic.
- **Search** remains near the dashboard because it is a cross-domain navigation utility.
- **Playback & Activity** remains under People: unlike Audit & events, it is customer/media usage rather than platform history.
- **Integrations** remains a Settings status hub even though individual integrations have deeper configuration pages; the hub answers a different question: “what is configured?”
- **Advanced** remains because configuration transfer and specialist automation tooling are legitimate but infrequent operator tasks and should not be promoted into primary navigation.

## Layout

The dashboard used 12-column cards with several `wide = 8/12` cards paired with another `8/12` card. This forced wrapping and left a visibly empty third of multiple rows. Business Performance and Streaming Operations now use balanced `6 + 6` cards. Commerce uses `8 + 4` followed by `4 + 8`.

## Reliability discovered during the audit

- A missing production Public base URL previously made `/health/ready` fail, which caused Traefik to withdraw an otherwise functioning storefront. Public-origin configuration is now reported as a degraded capability while core readiness remains based on database, migrations and runtime settings.
- Currency presentation could say “Prices in GBP” while falling back to a USD price for a plan without a GBP variant. Exact-currency plan decoration is now the default; products without the requested active currency variant are omitted instead of mislabelled.
