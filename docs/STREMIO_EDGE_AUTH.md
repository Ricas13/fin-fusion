# Stremio raw-media edge authorization

CAPTAiNFiN can keep Stremio media delivery completely out of the application byte path while preventing a raw Jellyfin URL from being replayed on another household network.

## Architecture

When `STREMIO_EDGE_AUTH_ENABLED=true`, Stremio stream results still point directly at the Jellyfin `/Videos/.../stream` endpoint, but CAPTAiNFiN removes the Jellyfin `api_key` from the URL and replaces it with an authenticated `cf_grant` value.

The grant is:

- encrypted and authenticated with a purpose-derived key;
- bound to the exact Jellyfin origin/path/query target;
- bound to the requesting household network (exact IPv4 or IPv6 /64, matching the existing household identity rules);
- time limited;
- opaque to the Stremio client.

A reverse-proxy edge middleware validates every GET/HEAD media request through CAPTAiNFiN's `/stremio-edge/authorize` endpoint. On success CAPTAiNFiN returns `X-Emby-Token` to the reverse proxy, which injects that header only into the upstream Jellyfin request. CAPTAiNFiN never receives or relays media bytes.

The authorization endpoint requires `X-CAPTAiNFiN-Edge-Secret`; never expose that shared secret to clients.

## Environment

```env
STREMIO_EDGE_AUTH_ENABLED=true
STREMIO_EDGE_AUTH_SECRET=<at-least-32-random-characters>
STREMIO_EDGE_GRANT_TTL_SECONDS=21600
```

`scripts/prepare-production-env.js --write` generates `STREMIO_EDGE_AUTH_SECRET` automatically when edge authorization is enabled and the secret is blank.

The default grant lifetime is six hours so long-running movies and repeated HTTP range requests do not expire mid-playback. Accepted values are 30 minutes to 12 hours.

## Traefik pattern

Use a higher-priority router for Jellyfin video requests carrying the `cf_grant` query parameter. Normal Jellyfin clients continue to use the ordinary router.

The protected router must call CAPTAiNFiN with ForwardAuth and copy only `X-Emby-Token` from the auth response into the upstream Jellyfin request.

Example dynamic configuration pattern (adapt host/service names to the deployment):

```yaml
http:
  routers:
    jellyfin-stremio-edge:
      rule: "Host(`jellyfin.example.com`) && PathPrefix(`/Videos/`) && QueryRegexp(`cf_grant`, `.+`)"
      priority: 200
      service: jellyfin
      middlewares:
        - captainfin-edge-secret-add
        - captainfin-edge-auth
        - captainfin-edge-secret-remove

  middlewares:
    captainfin-edge-secret-add:
      headers:
        customRequestHeaders:
          X-CAPTAiNFiN-Edge-Secret: "YOUR_SHARED_SECRET"

    captainfin-edge-auth:
      forwardAuth:
        address: "http://steam-fusion:3030/stremio-edge/authorize"
        trustForwardHeader: true
        authResponseHeaders:
          - X-Emby-Token

    captainfin-edge-secret-remove:
      headers:
        customRequestHeaders:
          X-CAPTAiNFiN-Edge-Secret: ""
```

The final removal middleware prevents the edge shared secret from being forwarded to Jellyfin. Keep the ordinary Jellyfin router in place for non-Stremio traffic.

## Failure behavior

- An expired grant returns 403 at the edge.
- A grant replayed from another household network returns 403.
- A grant copied to another Jellyfin host/path/media source returns 403.
- A direct call to `/stremio-edge/authorize` without the private edge secret returns 401 and never exposes a Jellyfin token.
- If edge authorization is disabled, CAPTAiNFiN keeps the existing direct authenticated Jellyfin URL behavior for compatibility.

Edge authorization should only be enabled after the protected Jellyfin router/middleware has been deployed. Enabling it first will intentionally make protected Stremio URLs unplayable rather than falling back to an exposed API token.
