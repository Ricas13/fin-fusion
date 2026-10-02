# Oversized module ownership review — 2026-10-02

This review applies the roadmap rule: size alone is not a reason to split a module. A split is justified only when it removes independent business decision owners or separates materially different reasons to change.

| Module | Current responsibilities | Decision |
| --- | --- | --- |
| `src/platform/admin-customers-list.js` | Customer-list filter parsing, read-model composition, CSV/list rendering and two HTTP routes. Business access decisions are delegated to customer/access helpers. | **Keep cohesive.** It is a presentation/read-model module despite its size. Continue moving generic HTML mechanics to shared helpers, not its customer-specific table/filter composition. |
| `src/platform/admin-orders.js` | Commerce order/report read model, range parsing, rendering and operator read-cursor/actions. It consumes payment ledger/profitability/incidents rather than owning provider money movement. | **Keep together for now.** Removed duplicate ISO calendar-date and CSRF mechanics in this PR. If reporting grows further, extract a pure orders read-model before splitting rendering. |
| `src/platform/admin-billing.js` | Billing operator pages and route/render orchestration over payment-domain services. It does not directly query/mutate billing tables. | **Keep cohesive.** A platform renderer/orchestrator is the appropriate owner; do not create a second billing service just to reduce file size. |
| `src/platform/admin-stremio-sources.js` | Stremio source administration transport/rendering with many route handlers plus source-state reads. | **Future split candidate.** Separate route/render concerns from source command orchestration only when command ownership can move behind the existing Stremio integration boundary without duplicating validation. |
| `src/integrations/request-user-sync.js` | Request-service API transport, identity/index management, permissions/quotas and bounded reconciliation. | **Domain owner, not platform debt.** Future decomposition should be internal: API client/transport vs reconciliation coordinator vs durable identity state. Do not move these decisions back into routes. |
| `src/payments/customer-plan-change.js` | One end-to-end plan-change state machine: validation, durable provider operation, provider scheduling and local transactional convergence. | **Keep cohesive.** Splitting provider steps from the state machine risks creating two owners for a high-risk money/access transition. Extract only pure helpers when reuse is demonstrated. |
| `src/payments/lifecycle.js` | Acquisition/trial/free lifecycle plus trial/free policy persistence and reconciliation entrypoints. | **Future split candidate.** Trial/free policy configuration can become a small policy owner; acquisition transitions should remain together with their transactional/access orchestration. |
| `src/jellyfin/activity.js` | Playback observation, policy enforcement, persistence and activity/policy read APIs. | **Future split candidate.** A read-model module can be extracted from observation/enforcement if it removes DB-query/render consumers without weakening the single enforcement path. |

## Review conclusions

- No file is being split solely because it is large.
- High-risk payment lifecycle/state-machine modules remain cohesive unless a split reduces decision ownership.
- Platform read/render modules may remain large when they are read-only/orchestration surfaces.
- Generic mechanics found during review should move to existing canonical helpers; this review already removed duplicate calendar-date parsing and CSRF hidden-input construction from `admin-orders.js`.
- Future splits should preserve current behavioural/concurrency/provider tests and add an ownership check before deleting the old surface.
