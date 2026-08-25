'use strict';

// End-user guide content. Plain JS data, parsed by the shared docs-render.js
// engine (see admin-docs-content.js for the same pattern on the admin side).

const SECTIONS=[
  {
    slug:'getting-started',
    title:'Getting started',
    pages:[
      {slug:'create-account',title:'Creating your account',body:
`Register with an email address and a password, then verify your email using the link we send you — most plans are only fully active once your email is verified. If you were referred by someone, use their referral link or enter their code during registration so the referral is correctly credited.

Once you're verified and on a plan, your **Home** page shows your current status, and **Setup** is where you connect the apps you'll actually watch on.`},
      {slug:'connect-jellyfin',title:'Connecting Jellyfin',body:
`If your plan includes Jellyfin access, your **Setup** page shows your Jellyfin server address and account details. Download a Jellyfin app for your device (TV, phone, browser, or media player app), enter the server address shown on Setup, and sign in with your Jellyfin username and password.

> Your Jellyfin password is separate from your CAPTAiNFiN account password. If you ever need to reset it, use the Jellyfin password option on your Setup page rather than your main account password reset.`},
      {slug:'connect-stremio',title:'Connecting Stremio',body:
`If your plan includes Stremio delivery, Setup gives you a one-click **install link** — opening it on a device with Stremio installed adds your personal channel automatically. If Stremio isn't installed yet, install it first from stremio.com, then come back and use the install link.

This link is personal to your account — don't share it. Anyone with the link can stream using your entitlement, and reduces the plan's normal usage effectively, since it counts against the household/device limits described in **Streaming limits & devices**.`}
    ]
  },
  {
    slug:'plan-and-billing',
    title:'Your plan & billing',
    pages:[
      {slug:'understanding-your-plan',title:'Understanding your plan',body:
`Your **Plan & billing** section shows what you're currently subscribed to, when it renews (or expires, for a fixed-term plan), and what it includes. If something you expect to have access to isn't showing up, check here first — it's the most accurate source for what your account is actually entitled to right now.`},
      {slug:'changing-your-plan',title:'Upgrading, downgrading or cancelling',body:
`You can change plans directly from **Plan & billing**. What happens next depends on your payment method:

- **Card payments (Stripe):** an **upgrade** takes effect immediately; a **downgrade** is scheduled for your next renewal date by default, so you keep what you already paid for until then.
- **PayPal:** if you have an active recurring PayPal subscription, you'll need to stop that renewal first before switching to a different plan — PayPal doesn't support changing an existing subscription in place the way card payments do.

Cancelling stops future renewals but does not cut off access you've already paid for — you keep it through the end of your current paid period.`},
      {slug:'payment-methods',title:'Payment methods and receipts',body:
`We accept card/bank payments through **Stripe**, **PayPal**, and one-off **cryptocurrency** payments through Plisio. Crypto payments are always one-time — there's no recurring crypto subscription, so a crypto-paid plan needs a fresh payment each renewal period rather than auto-renewing.

Receipts and payment history are available under **Plan & billing**, regardless of which method you used.`},
      {slug:'refunds-and-disputes',title:'Refunds and payment disputes',body:
`If something's gone wrong with a payment, contact **Support** first — most billing issues are resolved faster that way than through a card dispute or chargeback, and a dispute filed with your bank can take substantially longer to resolve than a support ticket.

> If you were referred by someone and later dispute or reverse a payment, be aware this can affect the referral credit tied to that payment.`}
    ]
  },
  {
    slug:'streaming-and-devices',
    title:'Streaming & devices',
    pages:[
      {slug:'household-limits',title:'Streaming limits and devices',body:
`Most plans limit how many concurrent streams, or how many separate households/networks, can use your account at once. If you try to stream from a new location while an older one is still counted as active, you may be blocked until that old connection clears.

This exists to keep an individual plan being used by one household or a defined circle, rather than shared indefinitely across unrelated people — it's not a per-device limit as such, it's about how many distinct networks are active at the same time.`},
      {slug:'resetting-household',title:'Resetting your connection when you travel',body:
`If you've moved to a new location (travelling, a new home network) and streaming is blocked because your old network is still marked active, use the **reset household connection** option on your Setup page to clear it immediately.

> This is meant for genuine location changes, not as a way to share one plan across multiple households at once. Depending on your plan's policy, resets may be rate-limited if used unusually often from clearly different networks in a short span.`}
    ]
  },
  {
    slug:'referrals',
    title:'Referrals',
    pages:[
      {slug:'refer-a-friend',title:'Referring a friend',body:
`If referrals are enabled on your account, your **Benefits** page has a personal referral link or code. Share it with a friend — when they register using it and their subscription becomes active, you'll earn credit once their subscription has been active long enough to qualify (this qualification window exists mainly to protect against fraud, not to make you wait unnecessarily).`},
      {slug:'earning-and-spending-credit',title:'Earning and spending credit',body:
`Earned referral credit starts in a **pending** state and becomes **available** to spend once the qualification window passes. Once available, you can redeem it toward a paid plan directly from **Benefits** — no separate checkout needed, since it's already your own balance.

> Referring yourself, or having a friend refer an account that's really the same household paying with the same payment method, doesn't qualify — the system checks for this, and it isn't worth the risk of losing legitimate credit you've earned elsewhere.`}
    ]
  },
  {
    slug:'account-and-security',
    title:'Account & security',
    pages:[
      {slug:'two-factor',title:'Two-factor authentication',body:
`Turning on two-factor authentication (2FA) under **Account** adds a second step at login using any standard authenticator app. We strongly recommend enabling it, especially if your account has an active paid plan.

> Save your recovery/backup codes somewhere safe when you set this up. If you lose access to your authenticator app and don't have a backup code, regaining access requires going through Support with identity verification, which takes longer than using a saved backup code.`},
      {slug:'change-password-email',title:'Changing your password or email',body:
`Both live under **Account**. Changing your email requires re-entering your current password, even if you're already signed in — this is a deliberate protection, so someone who merely gets hold of your open session can't quietly redirect your account to their own email address.

Changing either one signs out any other active sessions on your account, and we'll notify your old email address whenever it changes, as a safety check.`}
    ]
  },
  {
    slug:'getting-help',
    title:'Getting help',
    pages:[
      {slug:'open-a-ticket',title:'Opening a support ticket',body:
`Use **Support** to open a ticket any time — describe what's happening, and reply in the same thread as we respond. You'll see the full conversation history, and we'll notify you through whatever notification channels you have enabled when there's a reply.`},
      {slug:'faq',title:'Frequently asked questions',body:
`### Why can't I stream from my new location?
See **Streaming limits & devices** — your previous network may still be marked active. Use the reset option on Setup.

### Why hasn't my referral credit shown up yet?
Credit is held **pending** until your friend's subscription has been active past the qualification window — this is normal, not a sign anything's wrong.

### I changed my plan, why does it look unchanged?
A card-based downgrade is scheduled for your next renewal date by default, not applied immediately — check **Plan & billing** for the effective date. PayPal subscriptions need the old renewal stopped first.

### I lost access to my authenticator app for 2FA.
Use a saved backup code if you have one. Otherwise, contact **Support** — recovering access without a backup code requires identity verification and takes longer.`}
    ]
  }
];

module.exports={SECTIONS};
