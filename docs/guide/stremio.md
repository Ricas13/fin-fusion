# Stremio service

CAPTAiNFiN can provide a **stream-only Stremio addon** backed by a Jellyfin server. Stremio keeps its normal metadata/catalogue experience; CAPTAiNFiN supplies the eligible streams for a movie or episode.

> Before selling Stremio access, an administrator must complete the runtime setup and test the intended Stremio clients. The runtime deliberately stays fail-closed until it is enabled in the admin UI, its dedicated encryption key is configured, an eligible Jellyfin server is available and the media index is ready.

## Customer setup

If your plan includes Stremio:

1. Sign in to the CAPTAiNFiN customer portal.
2. Open **Stremio**.
3. Choose **Create installation**.
4. Use **Install in Stremio**, or copy the manifest URL into Stremio manually.
5. Open a movie or episode in Stremio. CAPTAiNFiN stream choices appear alongside any other installed addons.

The raw addon credential is shown only when it is created or rotated. CAPTAiNFiN stores a one-way hash rather than the raw installation credential.

### Rotate an installation

Use **Rotate installation** if the addon URL was exposed or you want to move to a new installation. Rotation invalidates the previous CAPTAiNFiN addon credential and also replaces the restricted Jellyfin playback session token.

### Revoke an installation

Use **Revoke installation** to stop Stremio access immediately. CAPTAiNFiN invalidates the addon credential, logs out the restricted Jellyfin session and disables the hidden Stremio Jellyfin identity.

## What credentials Stremio receives

Stremio does **not** receive:

- your normal Jellyfin password;
- your normal Jellyfin user token;
- a CAPTAiNFiN administrator login; or
- the Jellyfin administrator API key.

CAPTAiNFiN creates a dedicated internal Jellyfin identity for Stremio delivery. Its restricted playback token is encrypted at rest using a separate purpose key. The internal identity is hidden from normal customer Jellyfin account controls.

## Stream limits

The configured plan stream count is applied in three layers:

1. the dedicated Jellyfin identity receives the matching active-session limit;
2. CAPTAiNFiN checks recent active playback before returning stream options; and
3. the normal activity worker remains the post-start enforcement layer.

This is defense in depth. Administrators should still validate the exact behaviour on the Stremio clients they intend to support before launch.

## Stream names

CAPTAiNFiN enriches stream choices with Jellyfin media information when available and falls back to the `.strm` filename when needed.

Examples of recognised filename information include:

- `2160p`, `4K` or `UHD` → **4K**;
- `1080p` and `720p`;
- WEB-DL, WEBRip, BluRay and REMUX;
- HEVC/H.265, AVC/H.264 and AV1;
- Dolby Vision, HDR/HDR10/HDR10+;
- TrueHD, Atmos, DTS-HD, DDP/E-AC-3 and common channel layouts; and
- the release group at the end of a conventional release filename.

A stream may therefore appear as:

```text
[CF ⚡] 4K
BluRay • HEVC • Dolby Vision
TrueHD Atmos • 7.1
FraMeSToR
```

Unavailable information is left out rather than invented.

## Administrator setup

Open **Settings → Integrations → Stremio** and follow the setup guide in order.

1. Configure a unique `STREMIO_JELLYFIN_TOKEN_KEY` as a deployment secret. This is the only Stremio runtime secret that remains outside the browser; CAPTAiNFiN displays only whether the key is valid and never exposes its value.
2. Give each delivery Jellyfin server a public playback URL and enable the intended server(s) for Stremio.
3. Queue the media-index refresh and wait for at least one eligible server index to show **Ready** with a sensible IMDb title count.
4. Use **Enable runtime** on the Stremio settings page. CAPTAiNFiN refuses to enable it until the key, an eligible healthy server and a ready non-empty index are all present.
5. Create the intended plan delivery type: **Stremio** or **Bundle**.
6. Use a controlled test customer to create an installation and test movie + episode playback on every client you intend to advertise.
7. Only then make the Stremio plan publicly visible.

The runtime switch is stored in CAPTAiNFiN platform settings and can be disabled immediately from the same page. Runtime changes are audited. `STREMIO_RUNTIME_ENABLED` is retained only as an upgrade compatibility fallback for older deployments that have not yet saved the browser-managed setting.

Existing subscription service snapshots are not silently rewritten when an administrator changes a plan's delivery type.

## Media index

CAPTAiNFiN maintains a local IMDb-to-Jellyfin index for each Stremio-enabled server. A successful refresh replaces stale entries only after the full scan completes, so a failed partial refresh does not destroy the last known-good index.

The automation worker refreshes the index periodically. Administrators can also queue a full refresh from the Stremio settings page.

## Playback path

The data path is:

```text
Stremio
  → CAPTAiNFiN manifest/stream endpoint
  → entitlement + stream-limit check
  → local IMDb index
  → restricted Jellyfin playback metadata
  → direct Jellyfin media URL returned to Stremio
  → Jellyfin streams the video directly to the client
```

CAPTAiNFiN does not proxy high-bitrate video data.

## Current limitations

The runtime intentionally does not provide a CAPTAiNFiN catalogue; it is stream-only. It also does not yet promise perfect Jellyfin watched/resume synchronization from Stremio. Header-based direct playback must be tested on the actual Stremio Desktop/mobile clients you intend to support before public sale.

## Commercial direction

The current working commercial model is **$4/month per concurrent Stremio stream**. Pricing is a product decision and is not hard-coded into the addon protocol.
