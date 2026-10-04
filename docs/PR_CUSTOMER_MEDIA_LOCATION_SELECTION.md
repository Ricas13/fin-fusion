# Customer-selectable media server location

Follow-up to PR #877. This PR is intentionally opened as a draft implementation workspace so the work can be continued safely across multiple chats/commits.

## Product model

- A Jellyfin/Emby server owns its **physical capacity**.
- Every media server must support:
  - provider/type (Jellyfin or Emby)
  - administrator-defined display name
  - location/region
  - public/customer connection URL
  - maximum users/capacity
  - enabled/disabled + health state
- Existing server capacity rules from #877 remain the hard physical limit.

## Plan configuration

- A plan explicitly owns a pool of eligible Jellyfin/Emby servers.
- The plan editor must let an administrator:
  - select one or more media servers that can serve the plan
  - set the maximum users/places available on that plan
  - see the physical capacity of every selected server
  - see the combined capacity of the selected server pool
- The configured plan capacity must not exceed the combined physical capacity of the servers assigned to that plan.
- Shared physical servers remain shared capacity: assigning one server to multiple plans must never allow the physical server's user limit to be exceeded.
- Runtime allocation must continue to enforce both:
  1. plan capacity, and
  2. physical server capacity.
- Preserve the #877 compatibility/fallback behaviour for legacy configurations until the administrator explicitly configures a pool.

## Customer location selection

### Paid subscriptions

- During purchase/activation, derive the currently eligible, healthy, capacity-available locations from the selected plan's server pool.
- If there is only **one distinct eligible location**, do not show a location selector.
- If there are **multiple distinct eligible locations**, show a required location dropdown before provisioning.
- The customer chooses a **location**, not an internal server ID/name.
- If several eligible servers exist in the same chosen location, choose the actual server internally using capacity/health-aware allocation.
- Re-check capacity atomically at the final provisioning boundary so concurrent customers cannot overfill either the plan or the physical server.

### Free access

- Apply the same location-selection behaviour to joining the Free plan/server pool.
- Free inactivity thresholds/policy remain owned by the **Free plan**, as established by #877.
- Playback/activity used by the Free lifecycle must be read from the customer's actual assigned media server.

## Location performance test

- When multiple locations are available, provide a customer-facing way to test the available locations before choosing.
- Show measured connectivity/latency per location without creating a media account or reserving a permanent place.
- Do not automatically move or silently switch an existing customer after provisioning.
- The test must not expose administrator-only credentials or internal/private media-server addresses.
- A failed test must be presented as unavailable/failed rather than interpreted as zero latency.

## Persisted assignment

- Persist the selected media server (and location snapshot where useful for audit/history) on the authoritative customer access/subscription assignment.
- Existing customers retain their current server assignment unless explicitly repaired/reassigned by an administrator.
- Do not infer a different server later merely because plan pool ordering changes.
- Upgrades/downgrades/re-activation must reuse the valid existing assignment where appropriate, otherwise run the same eligible-location/allocation logic.

## Customer portal and account management

After provisioning, every customer-facing and automation path must resolve the customer's **actual assigned Jellyfin/Emby server**, not a generic plan/class default.

Audit and update at minimum:

- Jellyfin/Emby join/open URL shown in the portal
- server/location label shown to the customer
- account creation/provisioning
- account removal/cancellation
- failed-cancellation recovery/reconciliation
- password/account-management actions that target the media provider
- subscription reactivation
- plan upgrade/downgrade transitions
- Free join/remove lifecycle
- Free inactivity/activity checks
- playback/activity history lookups where server scoping matters
- access repair/reconciliation
- capacity reservations/pending activations
- admin customer detail/access views
- any Discord/email notifications containing a media-server URL or location
- any background automation that currently resolves a server via plan class/default server instead of the persisted assignment

## Availability and failure behaviour

- Do not offer disabled, unhealthy, or full locations.
- If a selected location becomes full between selection and provisioning, fail safely and ask the customer to choose from the remaining available locations; never silently overfill.
- If one location contains multiple servers and one fills/fails, allocation may use another eligible server in the same location.
- A server becoming unhealthy after account creation must not orphan the local subscription record or cause destructive account changes.
- Removing a server from a plan must not silently detach existing customers already assigned to it; admin repair/migration must be explicit.
- Reducing a plan cap or server capacity below current occupancy must not delete users. Block unsafe reductions or clearly preserve existing occupants while preventing new allocations.

## Admin UX

### Servers page

Each Jellyfin/Emby server should clearly expose:

- display name
- provider
- location
- public/customer URL
- max users
- current occupied users
- pending/reserved users where applicable
- available capacity
- health/enabled state

### Plans page

Each media plan should clearly expose:

- selected server pool
- locations represented by that pool
- physical pool capacity
- plan capacity
- current plan occupancy
- remaining plan places
- clear validation if plan capacity is above eligible physical pool capacity

Free inactivity configuration stays on the Free plan, not on an individual Jellyfin/Emby server.

## Migration / deployment safety

- Keep deployment compatible with the existing zero-downtime/N-1 approach established by recent hardening work.
- Avoid destructive migrations or semantics that older app generations would interpret differently during a rolling deployment.
- New nullable/defaulted fields must preserve current customers and existing server assignments.
- No existing account should be automatically moved merely because this feature is deployed.
- No existing active subscription should lose its Jellyfin/Emby URL or provider linkage during rollout.

## Regression protection

Before merge, add behavioural tests covering at least:

- one-server plan: no location selector, correct server used
- two locations: selector appears and chosen location is respected
- two servers in one location: no unnecessary location choice and allocator can use either server safely
- multiple servers/locations with one full server
- location becomes full between selection and provisioning
- concurrent acquisition of the final plan place
- concurrent acquisition of the final physical server place
- shared physical server used by multiple plans
- plan cap cannot be configured above selected pool capacity
- cancellation removes the account from the persisted assigned server
- cancellation/reconciliation after server/API failure
- reactivation preserves/reuses a valid assignment
- Free inactivity reads activity from the assigned Free server
- customer portal displays the correct URL for the assigned server
- legacy customer with an existing assignment remains unchanged
- disabled/unhealthy servers are not offered
- capacity reduction below occupancy never deletes customers
- performance-test failure is handled safely
- Jellyfin and Emby provider paths both work

## Merge gate

Do not merge until:

- migrations/compatibility are safe for production rollout
- all release-critical CI workflows are green
- existing deployment, billing, provisioning, cancellation, reconciliation, Free lifecycle, access repair, and server-capacity regression suites still pass
- new location-selection behavioural tests pass
- the implementation has been reviewed specifically for places that still resolve media servers by legacy class/default rather than the persisted customer assignment


## Regression audit trigger

A full exact-head regression pass was requested on 2026-10-04 after the final implementation follow-ups. This note intentionally triggers the complete PR workflow set so release evidence is tied to the audited head rather than an earlier commit.
