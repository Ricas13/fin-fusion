'use strict';

// Admin guide content. Kept as plain JS data (not files on disk) so it ships
// and reviews like the rest of the codebase's static content — see
// docs-render.js for how `body` (a small markdown subset) gets parsed.

const SECTIONS=[
  {
    slug:'getting-started',
    title:'Getting started',
    pages:[
      {slug:'welcome',title:'Welcome to the control centre',body:
`This is the admin guide for the day-to-day operator side of the platform — creating and adjusting plans, managing customers, keeping servers healthy, and handling payments. There's a separate guide for what your customers see, linked from **Settings → Support & legal**.

The admin panel is organised into six areas in the left sidebar:

- **Dashboard** — a single overview of health, activity and anything that needs attention.
- **Jellyfin** — your media servers and playback activity.
- **Stremio** — Stremio source pools, if you offer Stremio delivery.
- **Resellers** — reseller accounts, if you use them.
- **Customers** — every customer record and support tickets.
- **Commerce** — plans, storefront, orders, discounts, affiliates, and payments.
- **Operations** — provisioning, automation jobs, and backups.
- **Settings** — general, security, connections, commerce and system configuration.

> Most day-to-day work happens in **Customers** and **Commerce**. Treat **Settings** and **Operations** as places you visit less often, to configure things once and revisit only when something needs to change.`},
      {slug:'first-login',title:'Your first login and two-factor setup',body:
`The very first admin account is created either by the bootstrap script your host runs once during setup, or through the first-run wizard shown the first time the app starts with no admin account yet. Both paths stop working the moment one admin account exists — there's deliberately no ongoing "create another admin from scratch" flow outside of an existing admin inviting or creating one.

Two-factor authentication is required for every admin account. Set it up the first time you're prompted, using any standard authenticator app (Google Authenticator, Authy, 1Password, etc.) — scan the QR code or enter the setup key manually, then confirm with the 6-digit code it gives you.

> Keep your authenticator backed up. Losing access to it and being unable to sign in is a genuine lockout scenario — talk to another admin, or use your host's documented recovery path, before it happens rather than after.`},
      {slug:'step-up-2fa',title:'Why you are sometimes asked for a code again',body:
`Being logged in doesn't permanently authorize every action. A number of higher-impact actions — granting or revoking a customer's permanent access, reassigning a customer to a different server, restoring from backup, changing payment provider settings, and similar — require a **fresh** 2FA confirmation, even if you're already signed in.

This "step-up" check expires after a short window (10 minutes by default) from your last confirmation. If you've been idle or working on lower-impact pages, expect to be asked again the next time you touch one of these actions. This is intentional: it limits what a compromised or unattended session can do without your active involvement.`}
    ]
  },
  {
    slug:'customers',
    title:'Customers',
    pages:[
      {slug:'customer-360',title:'The customer record: six tabs, one place',body:
`Every customer has a single detail page (**Customers → click any customer**) with six tabs:

- **Overview** — plan, status, and the essentials at a glance.
- **Access** — the plan's default entitlements plus any admin overrides, and what actually applies (the "effective" policy) after both are combined.
- **Activity** — sign-ins, playback sessions, and recent behaviour.
- **Billing** — payment history, provider mapping, and subscription state.
- **Security** — 2FA status, portal login state, and account security signals.
- **History** — a timeline of everything that's happened to this customer's account.

This page is the canonical place to look before opening a support ticket or making a change — most "why isn't this customer's access working" questions are answered on the Access or Billing tab.`},
      {slug:'granting-access',title:'Adjusting a customer\'s access',body:
`A customer's actual access is always **the plan's defaults plus any override you set**, combined into one effective policy. You rarely need to touch the customer directly — most changes belong on the plan itself, so they apply consistently to everyone on that plan.

Use a per-customer override (on the **Access** tab) when one specific customer genuinely needs something different from their plan — for example, a temporary library exception, or a support gesture. Overrides are visible right next to the plan defaults, so it's always clear why a particular customer's access differs from everyone else on the same plan.

**Permanent access** is a separate, explicit grant that keeps a customer's service active independent of their subscription state — use it deliberately (e.g. a lifetime deal, a goodwill grant), not as a quick fix for a billing problem. It requires a fresh 2FA confirmation to set or remove.`},
      {slug:'household-resets',title:'Resetting a customer\'s household connection',body:
`Plans that limit customers to one active household/network connection occasionally need a manual reset — for example, a customer travelling and connecting from a new location while their old one is still marked active.

Customers can trigger this themselves from their account (self-service), and admins can do the same from the customer's record. Be aware of the plan's replacement policy before reaching for this repeatedly on the same customer's behalf:

- Under a **cooldown** policy, resets are deliberately rate-limited to discourage using this as a way to share one plan across several households.
- Under the **auto-inactive** policy (the default when a plan doesn't set one explicitly), resets are effectively unlimited aside from a generous request rate limit — so if you notice a customer resetting unusually often, it's worth a quick look at whether the plan's policy matches what you actually intend to allow.`},
      {slug:'support-tickets',title:'Support tickets',body:
`Customer support tickets live under **Customers → Support**. Each ticket keeps the full back-and-forth in one thread, and replying from here notifies the customer through their configured notification channels.

There's currently no volume limit on how many tickets or replies a single customer can send, so an unusually high-volume account is worth a look — it may be a customer in genuine distress, or worth a quiet rate-limit conversation with your engineering team if it's automated noise.`}
    ]
  },
  {
    slug:'plans-and-servers',
    title:'Plans & servers',
    pages:[
      {slug:'creating-a-plan',title:'Creating and editing a plan',body:
`Plans live under **Commerce → Plans & Storefront**. Each plan combines four things: what it costs, how many customers it can hold, which server class it places customers on, and what Jellyfin/Stremio access it grants.

Changing an existing plan's policy re-applies to every current customer on that plan — this is deliberate (it keeps every customer on a plan consistent), but it does mean a policy edit isn't purely cosmetic. Give the impact summary shown before saving a real look, especially on a plan with a large number of active customers.

Setting a plan's availability limit to 0 stops new customers from joining while leaving everyone already on it untouched — this is the normal way to retire a plan without disrupting existing customers.`},
      {slug:'jellyfin-library-access',title:'Jellyfin policy and library access',body:
`Each plan defines what its customers can see and do on Jellyfin — which libraries, and capabilities like downloads or transcoding. An admin override on an individual customer's Access tab can widen or narrow this for just that person; anything not overridden falls back to the plan's default.

> Setting a plan's library access mode to "all libraries" grants literal full access to every library on whatever server that customer is placed on — including anything intended for a different, more restricted tier sharing the same physical server. If you run mixed tiers on one server, double-check this setting specifically rather than assuming it only means "everything this tier is supposed to have."`},
      {slug:'managing-servers',title:'Managing servers',body:
`Server health, placement eligibility, and sellable stream capacity all live under **Jellyfin → Servers**. A server's placement state controls whether it can receive *new* customers — Draining or under Maintenance stops new assignments without moving anyone already there.

**Scanning a library and granting library access are two different things.** A library scan asks Jellyfin to refresh its own catalogue; it does not change which libraries any plan or customer can see. If a customer says new content isn't showing up, check the plan's library access first — a scan alone won't fix an access problem, and an access change alone won't surface content Jellyfin hasn't indexed yet.`}
    ]
  },
  {
    slug:'payments',
    title:'Payments & commerce',
    pages:[
      {slug:'providers-overview',title:'Payment providers at a glance',body:
`Three payment rails are supported: **Stripe** and **PayPal** for card/bank-based checkout and recurring billing, and **Plisio** for one-off cryptocurrency payments (crypto has no recurring billing — every crypto payment is a standalone invoice).

All three funnel through the same internal checkout process, so a customer's plan, price and identity are always resolved the same way regardless of which provider they used — you shouldn't need to think about "which provider" when investigating a customer's billing, except when the question is specifically about a receipt or a provider-side dispute.`},
      {slug:'discounts-and-referrals',title:'Discount codes and the referral/affiliate program',body:
`Discount codes (**Commerce → Discounts**) apply a percentage or fixed reduction at checkout, with an optional redemption cap and per-customer limit.

The referral program is the same feature as what you'll sometimes see labelled **Affiliates** in the sidebar — it's one system, referred to by both names in different places today. A customer refers a friend, and once the referred friend's subscription has been active past a qualification window, the referrer earns spendable credit. Credit can then be redeemed toward a plan.

> If you're chasing down "why does this customer have credit" or "why hasn't this credit arrived yet," look under **Affiliates**, even if the customer described it to you as "the referral thing."`},
      {slug:'commerce-pause',title:'Pausing new purchases (the commerce kill switch)',body:
`**Settings → Commerce** includes a single pause toggle that blocks all *new* purchases platform-wide — useful if you're responding to a fraud spree, a pricing misconfiguration, or a payment-provider incident. Existing paid customers keep their access; this only stops new checkouts from completing.

> Affiliate credit redemption is a separate code path from checkout and is not currently affected by this pause. If you've paused commerce specifically to stop a suspected abuse pattern involving credit, know that a customer can still redeem existing credit while the pause is active — worth keeping in mind rather than assuming the pause is a total stop on new activations.`},
      {slug:'reconciliation',title:'Reconciliation and payment incidents',body:
`When a payment provider's state and CAPTAiNFiN's own record disagree — a subscription that should be active but isn't, or vice versa — it shows up as an incident under **Commerce → Payments & Billing**. Resolving an incident re-verifies the provider's actual current state before restoring anything, rather than trusting whatever triggered the incident in the first place.`}
    ]
  },
  {
    slug:'bulk-operations',
    title:'Bulk operations',
    pages:[
      {slug:'the-pattern',title:'Select, preview, confirm, job',body:
`Every bulk action on the Customers list (library changes, plan/entitlement changes, Jellyfin reconcile/retry, reseller assignment, export, and more) follows the same four-step pattern:

1. **Select** the customers, either individually or "select all matching this filter."
2. **Preview** what will happen — this re-evaluates against current data at preview time, not stale data from when you first opened the page.
3. **Confirm** — larger or higher-impact actions require typing a confirmation phrase.
4. **Job** — the action runs as a background job with per-item progress, so a bulk action on thousands of customers doesn't block you or time out.

Because selection is re-resolved at confirm time, a customer whose plan or status changed between your preview and your confirmation is handled correctly — the job acts on the selection as it stands at execution, not a stale snapshot.`}
    ]
  },
  {
    slug:'security-and-backups',
    title:'Security & backups',
    pages:[
      {slug:'audit-log',title:'The audit log',body:
`Every privileged admin action — plan changes, access grants, payment settings, backups, and more — is recorded in the audit log (**Operations → Automation**, Audit log). It's the first place to check when you need to know who did what and when, including for actions taken by other admins.`},
      {slug:'backups',title:'Backups and restore drills',body:
`Backups are scheduled automatically and can be triggered on demand from **Operations → Backups & Recovery**. From the admin panel you can see backup history, sizes, checksums, and run a **restore drill** — a real, non-destructive full restore into a scratch database that verifies the backup actually works, not just that a file exists.

> Restoring a backup into your live, production database is deliberately **not** available from the web admin panel at all — it's a command-line operation on the host, gated behind an explicit confirmation phrase. This is intentional: it keeps "restore production" from ever being one accidental click away, even for a fully compromised admin session.`}
    ]
  }
];

module.exports={SECTIONS};
