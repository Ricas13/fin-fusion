# Test architecture and proof levels

CAPTAiNFiN deliberately uses more than one kind of test. The important distinction is what each test actually proves.

## Classification

### 1. Mounted HTTP/runtime integration

The test sends requests through the same application/router composition used in production. For authenticated mutations it must establish a real session, obtain a real CSRF token where required, POST the mounted route, and assert the resulting database or durable state change.

Examples:

- `tests/admin-mounted-mutations-journey.js`
- `tests/admin-customer-activation-journey.js`
- `tests/admin-deferred-provisioning-journey.js`
- the authenticated route crawl in `tests/admin-browser-regression.js` (runtime reachability/UI proof; not every crawled form is mutation-proven)

A handler existing in source is **not** mounted-runtime proof.

### 2. DB integration / state machine

The test executes real application/domain code against PostgreSQL and asserts persisted transitions or invariants, but does not prove that an HTTP route is mounted or reachable.

Representative examples:

- `scripts/lifecycle-integrity-smoke.js`
- `scripts/free-access-registration-reservation-db-smoke.js`
- `scripts/platform-coherence-db-smoke.js`
- `scripts/marketing-segments-db-smoke.js`
- `scripts/provisioning-control-db-smoke.js`
- billing/referral/payment lifecycle smoke tests that use the migrated CI database

These are valuable for state-machine correctness, concurrency, and accounting invariants. They must not be described as mounted route coverage.

### 3. Unit

The test executes an isolated helper/module contract without requiring the production HTTP mount or a real database. Use this for parsing, validation, policy, rendering primitives, and other deterministic logic.

A source-text assertion is not a unit test merely because it is small.

### 4. Static/source-contract

The test reads source text or route declarations and checks strings, regexes, import boundaries, ownership declarations, migration discipline, or architectural contracts.

Representative examples:

- `scripts/admin-route-ownership-audit.js`
- `scripts/platform-router-composition-smoke.js`
- `scripts/workflow-handler-coverage-smoke.js`
- `scripts/admin-personal-notification-save-smoke.js`
- boundary/canonical-ownership checks

These tests remain useful. They catch accidental duplication, forbidden imports, missing declarations, and known source-shape regressions cheaply. They do **not** prove that production mounts the checked handler or that a real mutation succeeds.

## Mutation proof rule

For an important state-changing HTTP route, CI may use static/source and DB tests as supporting evidence, but the route is only **runtime-proven** when a mounted test reaches the production application composition and verifies its externally observable state effect.

Do not write or review a test description such as “save works”, “route works”, or “integration” when the test only searches source text. Prefer explicit labels such as `source contract`, `DB state machine`, or `mounted runtime`.

## Current high-risk coverage map

| Workflow | Current strongest proof | Notes |
| --- | --- | --- |
| Admin/customer activation and sign-in | Mounted runtime | Existing browser journey posts the real admin/customer flows. |
| Deferred Jellyfin provisioning after activation | Mounted runtime | Existing browser journey covers the production application plus DB effects. |
| Personal admin notification settings | Mounted runtime | `admin-mounted-mutations-journey.js` posts `/admin/profile/notifications` with a real session/CSRF and verifies preference plus audit rows. The older source-binding smoke remains a source contract. |
| Support/legal admin settings | Mounted runtime | The mounted journey submits the real form and verifies `support_policy_v1`; it also guards the structured field-help migration. |
| Stremio runtime setting | Mounted runtime | The mounted journey posts the canonical `/admin/servers/stremio/runtime`, verifies durable state, and proves the legacy POST is compatibility-only. |
| Stremio source/account/password mutations | Source/DB coverage varies | High-risk external mutations still need targeted provider fixtures before they should be called runtime-proven. Do not infer proof from handler-source smokes. |
| Provisioning control | Mounted runtime + DB state machine | Deferred provisioning has a browser journey; broader retry/reconcile controls retain DB/source coverage and should gain mounted fixtures when changed. |
| Payment webhook routing | Mounted runtime routing + provider/domain tests | The mounted journey distinguishes the real Stripe webhook handler from the application 404 fallback. Successful signed provider events remain domain/provider integration concerns and must not be inferred from route-source checks. |
| Destructive admin actions | Source/DB coverage varies | Treat delete/revoke/terminate handlers as not runtime-proven unless a mounted journey explicitly asserts the destructive state transition. |
| Free-tier inactivity enforcement | DB/state-machine coverage | Lifecycle/inactivity tests can prove policy transitions; an HTTP route is not implied because enforcement is primarily worker-owned. |

When touching a high-risk row that is not yet mounted-runtime proven, prefer adding a focused runtime fixture rather than expanding source inspection.

## Admin rendering rule

New semantic application behaviour must live in the owning route/template/component when practical. Do not add new behaviour by rendering an HTML string and then searching labels, destinations, or literal markup to splice semantic content into it.

Preferred pattern:

```js
field({
  label: 'Terms URL',
  help: 'Public URL containing the service terms customers should be able to review.',
  control: '<input ...>'
})
```

`admin-html.js` still contains legacy compatibility post-processing. `SETTING_HELP` is migration debt and should shrink; do not add new field semantics to it. Destination rewrites should be replaced by canonical route/template ownership when a safe scoped migration is available.

`stripInlineScripts()` is different: it is an intentional security boundary for legacy server-generated fragments and should remain until a separately proven canonical replacement exists.

## Ownership rule

Compatibility routes may redirect to a canonical owner, but should not keep a second copy of mutation logic once the canonical route is established. Runtime tests should target the canonical mounted owner and, where compatibility matters, assert the redirect/delegation contract separately.
