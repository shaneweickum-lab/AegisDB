# Deployment

AegisDB has two genuinely different things that can be deployed, and they
go to different kinds of hosts on purpose.

## The static visualizer demo — Vercel

`public/` is plain static HTML/CSS/vanilla JS (no build step, no
framework, no bundler — consistent with the project's zero-runtime-dep
approach throughout). `vercel.json` at the repo root points Vercel at
`public/` as a static site with no build command.

This deliberately **does not** attempt to run the actual AegisDB server on
Vercel. Vercel's serverless functions have an ephemeral, effectively
read-only filesystem — the writable `/tmp` they do offer is wiped between
invocations — which is incompatible with Phase 2's whole premise (an
append-only flat-file database whose durability guarantees depend on
`fsync` and atomic rename against a real, persistent disk). Vercel also
doesn't support the kind of long-lived, hand-rolled WebSocket server Phase
5 implements. Attempting to force either onto serverless functions would
mean silently downgrading the two most distinctive parts of this project
to a "toy mode" that resets on every cold start — not worth pretending is
the real thing.

So: **Vercel hosts the frontend only.** The frontend doesn't hardcode a
backend location — `public/js/app-config.js` resolves the backend's
HTTP/WS base URL from a `?backend=` query parameter (falling back to a
local-dev default), so the same static deployment can point at whichever
real backend is currently running, wherever that is.

## The real server — local machine + tunnel, or a small VPS

This is where `aegis.data`/shard files actually live and where the WS
telemetry stream actually runs, per the original spec's own two options
(Section 9.2) and this project's Phase 10 `deploy/config.ts`:

- **Local + tunnel:** run the server on your own machine, front it with a
  tunnel (e.g. Cloudflare Tunnel, ngrok) for a public HTTPS/WSS URL.
- **Small VPS:** run the same server binary on a VPS you rent/own, bind
  `0.0.0.0`, and put a TLS-terminating reverse proxy in front (or use
  `node:https` directly with your own certs).

Either way, point the Vercel-hosted frontend at that URL via `?backend=`.
Copying data between the two modes (or between machines) is exactly
Section 9.2.2's migration path — copy the shard's data files, no format
conversion.

### Configuration

One env-driven config (`src/deploy/config.ts`), read once at boot
(`npm run dev`, or `node dist/index.js` after `npm run build`) — nothing
else in the codebase branches on deployment mode:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AEGIS_MODE` | `local-tunnel` | `local-tunnel` or `vps` |
| `PORT` | `8787` | `0` lets the OS assign an ephemeral port |
| `AEGIS_DATA_DIR` | `./data` | where `shard.data`/`shard.index` live |
| `AEGIS_SESSION_TTL_MS` | `1800000` (30 min) | session idle timeout |
| `AEGIS_TUNNEL_PROVIDER` | `cloudflare` | `cloudflare` or `ngrok` (local-tunnel mode only) |
| `AEGIS_TUNNEL_SUBDOMAIN` | — | informational only — configure it in your tunnel provider, not here |
| `AEGIS_PUBLIC_HOST` | — | informational only (vps mode) — point DNS/your reverse proxy here yourself |

Invalid values (bad mode, out-of-range port, empty data dir, etc.) fail
fast with a clear message before the server ever starts listening,
rather than surfacing as a confusing runtime error later.

```
AEGIS_MODE=local-tunnel PORT=8787 npm run dev
# in another terminal:
cloudflared tunnel --url http://localhost:8787
```
