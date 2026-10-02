# Repository merge gates

Pull requests into `main` are intended to be mergeable only after the exact PR head has passed all release-critical workflows below:

- CI
- Release Integrity
- Integration
- Browser & Clean Install
- Security CodeQL
- Stremio

All six workflows must run on `pull_request`. A green run from an older PR head is not sufficient after new commits are pushed.

The GitHub repository ruleset should require these checks and require the pull request branch to be up to date with `main` (or use merge queue) before merge. Any repository-owner bypass should be deliberately configured, limited, and used only for documented emergency recovery.

This file is the repository-side contract. `scripts/repository-merge-gates-smoke.js` verifies that the named workflows still exist and remain wired to pull requests. GitHub ruleset enforcement itself is configured in repository administration and cannot be guaranteed by source code alone.
