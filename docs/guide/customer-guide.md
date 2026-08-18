# Customer guide

## My account

The customer portal is organised around the things a customer normally needs to do:

- **Overview** — current plan and access status.
- **Streaming** — Jellyfin sign-in/password and Stremio setup when included.
- **Plans & billing** — available plans, renewal controls and billing history.
- **Activity** — recent playback and unusual stream-limit actions.
- **Notifications** — optional Telegram, Discord and WhatsApp preferences.
- **Security** — profile, portal password, optional two-factor authentication and signed-in sessions.
- **Benefits** — referral code and service credit when the affiliate programme is enabled.
- **Help & support** — published help and support contacts.

Customer-facing states use **Ready**, **Setting up** and **Needs attention** wherever possible instead of internal provisioning terminology.

## First access

After a successful paid checkout, Free Access claim, trial activation or account activation, the customer is taken through the welcome/setup experience. If Jellyfin is included, the page shows the Jellyfin server and username and asks the customer to choose a Jellyfin password when required.

If Jellyfin setup is still running, the portal explains that CAPTAiNFiN will keep retrying and also provides a **Try again now** action. The customer does not need to understand server placement or reconciliation.

## Changing plans

The portal explains the timing before a customer continues:

- A Stripe upgrade can take effect immediately and may create a prorated charge that day.
- A lower-cost Stripe change is normally scheduled for the next renewal.
- An active recurring PayPal agreement must have renewal stopped before it can be replaced. Existing paid access remains until its paid-through date.

## Streaming

The CAPTAiNFiN portal password and Jellyfin password are separate. Customers can change their own Jellyfin password from **Streaming** and their portal password from **Security**.

For Stremio plans, the customer creates a private installation link from **Stremio setup**. The full private installation link is shown when it is created; losing it means creating a replacement rather than revealing the old secret again.

## Library visibility

The plan controls which Jellyfin libraries a customer can access. The customer can hide or show libraries already granted by the plan, but cannot grant themselves additional libraries.

## Content requests

If a request service is configured, the portal shows whether the request account is ready or still being prepared and provides the configured request-site link.

## Free Access

Free Access remains visible even when all places are occupied. When capacity is zero, the customer sees that it is currently full rather than the plan disappearing.

## Getting support

Use **Help & support** from the customer navigation. When contacting support, describe the page/action and your portal username. Never send passwords, two-factor recovery codes or private Stremio installation links.
