# Plans vs servers: what belongs where

Review date: 2026-10-31. Based on the plan editor, the server editor, the `plans` and
`jellyfin_servers` tables, and the customer, placement and provisioning code that reads them.
This is a recommendation document; nothing here changes behaviour by itself.

## The rule that keeps things simple

> **A plan describes what a customer is allowed to have. A server describes what a machine
> can physically do.**
>
> Anything a customer sees, buys or is limited by is a plan setting. Anything about hardware,
> network location, health or capacity is a server setting. Placement is the only place the
> two meet, and it should read from both and be configured in neither twice.

## Where each setting lives today

| Setting | Lives on | Right home? |
|---|---|---|
| Price, billing interval, duration, currency, provider price mapping | Plan | Yes |
| Concurrent streams, household network lease | Plan | Yes |
| Downloads, transcoding, remuxing, Live TV, remote access, 4K flag, subtitle editing | Plan | Yes |
| Library visibility (all / named / all-except) | Plan | Yes (see "Libraries" below) |
| Jellyseerr request quotas and permissions | Plan | Yes |
| Discord role | Plan | Yes |
| Free-user inactivity thresholds | Plan (authoritative) **and** server columns (legacy) | Plan only |
| Storefront visibility, order, availability window | Plan | Yes |
| Server class (Premium / Free / Custom) | Plan **and** server | Duplicated, see below |
| Explicit eligible-server list and weights | Plan (`plan_server_eligibility`) | Yes, but see below |
| Placement strategy (balanced etc.) | Plan | Acceptable |
| Maximum customers on this plan | Plan (`capacity_limit`) | Yes |
| Customer capacity (`max_users`) | Server | Yes |
| URL, API key, location, media-server type | Server | Yes |
| Health, last check | Server | Yes |
| Placement mode (Active / Drain / Maintenance) | Server | Yes |
| Placement priority | Server | Yes |
| Allow new users / Allow trials / Allow paid | Server | Overlaps plan class, see below |
| Stremio enabled / Stremio priority | Server table | Wrong table, see below |
| Per-server connection policy and messages | Media controls (per plan and per server) | Split across two pages |

## Overlaps that make the admin experience confusing

1. **Server class is asked twice.** The plan chooses Premium / Free / Custom, and so does the
   server. Help text on the server form says it is only a fallback for plans with no explicit
   server selection, which means most administrators set it and nothing visibly changes.
   - Recommendation: keep the class on the server (it is a property of the machine), and on the
     plan replace the three-way dropdown with a single "Which servers can host this plan?"
     picker (All Premium servers / All Free servers / Choose servers). The class stays an
     implementation detail.

2. **"Allow trials" and "Allow paid" on the server duplicate what the plan already decides.**
   A trial plan and a paid plan already know they are trials or paid. A server flag that
   silently refuses one of them produces the "why was my customer placed on server B" question.
   - Recommendation: remove the two checkboxes from the normal server form and fold them into
     one read-only line on the server page ("Hosts: Premium plans, trials"), derived from the
     plans that list this server. Keep `allow_new_users` and the Active / Drain / Maintenance
     mode, which are genuinely server-level.

3. **Free-user inactivity lives in two places.** The plan page says the plan thresholds are
   authoritative, while three columns on the server row still carry the old values and the
   Servers list still shows them ("first playback within 3d · 30 min / rolling 7d").
   - Recommendation: finish the migration. Show the plan's values on the Servers list (labelled
     with the plan name) and drop the server columns once no plan relies on the legacy
     fallback.

4. **Capacity is expressed three ways.** Server `max_users`, plan `capacity_limit`, and the
   derived "plan used / reserved / effective limit / open" tiles. The plan page explains the
   relationship well, but an administrator has to open both screens to answer "can I sell 20
   more of these?".
   - Recommendation: add one line to the Plans list and the plan header: "Can sell N more
     (limited by <plan limit | server X>)". It is already computed on the plan page.

5. **Stremio configuration is stored on the Jellyfin servers table** (`stremio_enabled`,
   `stremio_priority`) while Stremio sources have their own page and the plan has its own
   source mapping. A Stremio source is not a Jellyfin server.
   - Recommendation: move these two columns to the Stremio source record in a later migration
     and keep the Stremio page as the only place to configure delivery.

6. **Libraries are controlled in three places**: the plan (what the plan may see), the server
   (what exists, with its own Libraries page and scans), and per customer overrides. The plan
   editor already warns "Could not read libraries from…" when a server is unreachable.
   - Recommendation: keep the plan as the owner of "who may see what", make the server page
     the owner of "what exists" (read-only list plus Scan), and make customer overrides an
     exception list that visibly says how many customers differ from their plan.

7. **Concurrent streams and connection limits are split.** Streams are on the plan, while the
   IP and device limits and the expiry messages sit under "media controls" for the plan, and a
   separate server-wide message tool exists.
   - Recommendation: show the connection policy as a card on the plan editor rather than a
     separate route, and keep only the one-off "message this server's viewers" tool on the
     server page.

## Settings that should move or change

| Move | From | To | Why |
|---|---|---|---|
| Trial / paid placement flags | Server form | Derived, read-only | Plans already decide it |
| Free inactivity thresholds | Server columns | Plan only | One owner |
| Stremio priority / enabled | Servers table | Stremio source | Not a Jellyfin concept |
| Connection policy | Separate media-controls route | Plan editor card | One place per plan |
| Server class on plan | Three-way dropdown | "Which servers" picker | Hide the implementation detail |

## Plan editor: reducing the visual load

The plan editor has eight cards, each with its own Save button, its own "Confirm impact"
typed-code field, and its own Advanced section. On a plan with live customers that is eight
copies of "Type assess-monthly to save this card".

- Ask for impact confirmation once per page save (the "Save changes" bar already batches the
  sections) instead of once per card.
- Group the cards into three tabs or anchored sections: **Sell it** (product, commercial,
  availability), **Deliver it** (access, delivery & placement, libraries) and **Integrations**
  (requests / Jellyseerr, Discord).
- Keep Advanced collapsed by default and open it inside the card, never across the grid. This
  review's code change does exactly that.

## Suggested order

1. Show "Can sell N more" on the plan list and header (no schema change).
2. Hide the trial/paid server checkboxes behind a derived read-only line (UI only).
3. One impact confirmation per plan save.
4. Retire the legacy Free-inactivity server columns once no plan uses the fallback.
5. Move the Stremio columns to the Stremio source (migration).

## What was verified

The table columns were read from the migrated schema. The server form text and the plan
editor were rendered and read in a running instance. Overlaps 1, 2, 3 and 5 are visible
directly in the forms and column lists. Overlaps 4, 6 and 7 are based on how the pages and
queries are organised; I did not trace every code path that reads them.
