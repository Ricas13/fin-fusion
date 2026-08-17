# Servers and libraries

CAPTAiNFiN can manage more than one Jellyfin server and place customer accounts according to plan and server eligibility.

## Server configuration

A server record normally includes:

- a human-readable name and slug
- server class such as premium, free or custom
- internal base URL used by CAPTAiNFiN
- public URL used by customers and playback clients
- encrypted Jellyfin API key
- enabled/disabled state
- priority and optional capacity limit
- current health information

## Base URL vs public URL

Use the **base URL** for reliable server-to-server communication from CAPTAiNFiN. Use the **public URL** for the externally reachable address that customers or client applications should use.

## Health and placement

An enabled server still needs to be healthy and eligible for the customer plan before placement should select it. Capacity and explicit plan placement rules can further limit new assignments.

## Libraries

CAPTAiNFiN reads Jellyfin libraries and can attach library entitlements to plans. A plan determines the maximum library set a customer may receive.

If a customer is allowed to choose libraries, their selection can only reduce that entitled set. It cannot be used to bypass plan restrictions.

## Existing customers

Changing a server class or future placement rule does not silently migrate every existing customer. Use the server migration workflow when accounts actually need to move between Jellyfin servers.

## Troubleshooting server access

If a server cannot be reached:

1. confirm the server is enabled;
2. test the configured base URL from the CAPTAiNFiN host;
3. confirm the API key is valid;
4. check health/status information;
5. confirm the plan is eligible for the server;
6. review application logs for the request ID and upstream error.
