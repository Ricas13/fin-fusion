# Required merge gates for `main`

Normal pull requests into `main` are expected to be current with the target branch and pass all release-critical workflows before merge:

- CI
- Release Integrity
- Integration
- Browser & Clean Install
- Security CodeQL
- Stremio

The repository ruleset should require these checks rather than relying on reviewer memory. Merge-queue or equivalent up-to-date-base enforcement is preferred so a PR that was green against an older `main` cannot bypass combined-main validation.

Emergency or owner bypass, if enabled in GitHub repository settings, must remain an explicit administrative action. It is not part of the normal deployment path and should be used only when the operator deliberately accepts the missing merge evidence.

This file is checked by `scripts/required-merge-gates-smoke.js` so workflow renames/removals cannot silently make the documented merge policy stale. The smoke test documents repository intent; GitHub branch/ruleset settings remain the enforcement mechanism.
