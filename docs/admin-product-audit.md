# CAPTaINFiN admin product audit

This audit treats the administrator UI as a product, not just a set of routes.

## Review questions

Every visible administrator destination is reviewed against three questions:

1. **Does it work?** The route renders under a real authenticated browser session, safe forms round-trip, and the page has no console/page errors or document-level overflow.
2. **Does it belong?** A first-class sidebar entry should represent an everyday operator job. Diagnostic/detail pages should live as workflow tabs or contextual links under the job that owns them.
3. **Does it still look intentional?** Card grids should fill rows coherently at desktop sizes, mobile pages should not overflow the viewport, and related pages should expose stable top-level workflow tabs.

## Current information-architecture decisions

- `Policy Drift` is a Provisioning sub-workflow rather than a separate Automation sidebar item.
- Notification `Delivery health` is part of the global Notifications workflow rather than a separate Automation item.
- Cross-platform `Audit & events` is historical/operational information, not a Dashboard landing-page task, so it lives under Automation.
- `My Notifications` remains a top tab inside `My Profile`, not a duplicate Settings sidebar destination.
- The old Settings `Commerce` link remains removed because Commerce already has a dedicated primary navigation group.

## Browser coverage

The `Admin Browser Regression` workflow boots a clean PostgreSQL database, creates a real administrator account, starts CAPTaINFiN, signs in with Chromium, crawls the admin surface, captures page screenshots/inventory, tests desktop/mobile overflow, checks dashboard grid row coverage, verifies workflow-tab stability, and performs safe My Profile email/reporting-currency form submissions.

External integrations and destructive/operational actions are intentionally not blindly executed by the crawler. Their route wiring remains covered by the static visible-action sweep and their behavior by dedicated integration/safety suites.
