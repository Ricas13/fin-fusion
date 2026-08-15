# Stremio service roadmap

> Stremio delivery is a **foundation/in-development feature**. Do not sell or advertise it as live until the addon runtime, playback bridge and platform-compatibility testing are complete.

CAPTaINFiN is being prepared to offer a stream-only Stremio service backed by an assigned Jellyfin server.

## Intended customer experience

The customer browses movies and episodes using Stremio's normal metadata/catalogue experience. CAPTaINFiN does not need to publish a competing catalogue. When the customer opens a title, the CAPTaINFiN addon returns eligible Jellyfin-backed stream choices.

## User-specific access

Each active Stremio entitlement will use its own opaque installation credential. The credential identifies the customer entitlement, stream allowance and assigned Jellyfin service without exposing a CAPTaINFiN administrator API key.

Credentials are designed to be rotatable and revocable. Stored bearer credentials should be represented by a one-way hash where possible.

## Jellyfin relationship

Jellyfin remains the media/data plane. CAPTaINFiN is the control plane that decides whether the subscription is active, which server the customer belongs to and how many simultaneous streams are permitted.

A Stremio-only customer may still need a restricted internal Jellyfin user so playback can be authorized without granting normal Jellyfin portal credentials.

## Stream names

`.strm` media may not have complete probed media information before playback. The addon therefore needs a graceful filename fallback.

Examples:

- `2160p`, `4K` or `UHD` → **4K**
- `1080p` → **1080p**
- `720p` → **720p**

Where reliable filename tokens exist, the display can also identify source, codec, HDR format, audio and release group. Information must not be invented when it cannot be determined.

A future stream entry may look like:

```text
[CF ⚡] 4K

WEB-DL • HEVC • Dolby Vision
DDP Atmos
MGE
```

If Jellyfin already has probed media details, those details can enrich the entry. Filename-derived resolution remains the fallback.

## Commercial direction

The current working concept is **$4/month per concurrent Stremio stream**. Pricing remains configurable and is not hard-coded into the addon foundation.

## Not in the foundation release

The foundation does not yet promise:

- a production Stremio manifest/stream endpoint
- live playback admission enforcement across every Stremio platform
- perfect Jellyfin watch-progress synchronization
- a CAPTaINFiN Stremio catalogue

Those items require the dedicated addon/runtime project and end-to-end testing.
