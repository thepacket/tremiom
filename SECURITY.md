# Security

## Threat model

Tremiom is a single-owner web app. The intended deployment is:

- One operator runs a Fly.io instance for their own use
- The operator sets `TREMIOM_TOKEN` to a secret string
- Browsers visiting the instance must present a matching cookie

There is no concept of multiple user accounts. The token is the only
authentication credential. Anyone who learns the token can use the
instance.

## What's protected

When `TREMIOM_TOKEN` is set in the environment, the multiplexer rejects
**every** HTTP and WebSocket request that doesn't present a matching
cookie:

- `GET /` and all static assets
- All `/api/*` endpoints except the three auth helpers (`login`,
  `logout`, `status`)
- The WebSocket upgrade at `/ws/main`

When `TREMIOM_TOKEN` is unset, the server is open. This is the default
for local development and self-hosting on a trusted network.

## Cookie

- Name: `tremiom_auth`
- Flags: `HttpOnly; SameSite=Lax; Secure; Max-Age=31536000; Path=/`
- `Secure` is set when the request arrived over HTTPS (detected via the
  `x-forwarded-proto` header or `req.socket.encrypted`)
- The cookie's value is the token verbatim — there is no separate
  session table. Rotating `TREMIOM_TOKEN` server-side invalidates
  every existing cookie instantly.

## Token comparison

`tokenEqual()` in `server.mjs` is a constant-time string compare. We
don't use Node's `crypto.timingSafeEqual` because it requires equal-
length buffers and we want a graceful early `false` on length mismatch
without leaking the expected length through different code paths.

## What's NOT in the repo

The following file patterns are gitignored and never committed:

```
.env, .env.*           — environment files
*.pem, *.key           — TLS / private keys
*.p12, *.pfx, *.jks    — keystores
id_rsa*, id_ed25519*   — SSH keys
secrets.*, .secrets    — anything explicitly named "secret"
.fly/                  — local Fly state
```

Fly.io secrets (set via `fly secrets set …`) are stored in Fly's
encrypted secret store, injected into the runtime environment, and
never written to the Docker image.

## Reporting a vulnerability

Since Tremiom is a personal project that does not accept pull requests
(see [`CONTRIBUTING.md`](./CONTRIBUTING.md)), the most direct way to
report a security issue is to open a GitHub
[discussion](../../discussions) or
[issue](../../issues) with the label "security". For anything
sensitive (active exploit, credential exposure), please email the
maintainer privately rather than filing publicly.

## Known limitations

- **No rate limiting on `/api/auth/login`.** A single TREMIOM_TOKEN is
  the only secret, and the failure log records the source IP, but the
  endpoint doesn't yet exponential-backoff on repeated failures. If
  you expect adversarial scanning, set `TREMIOM_TOKEN` to a long,
  high-entropy string (e.g. `openssl rand -hex 32`) and trust your
  cloud provider's edge to absorb traffic.
- **Single secret = single revocation.** Rotating invalidates *all*
  cookies, including the operator's. There is no per-device sign-out.
- **No 2FA.** Out of scope for a personal-deployment app.
