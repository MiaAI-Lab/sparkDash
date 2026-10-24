# Remote access

sparkDash includes administrative actions such as credential changes, benchmarks, updates, and power controls. It binds to `127.0.0.1` by default. Set `SPARKDASH_TOKEN` to protect changes and WebSocket telemetry (and REST reads on a remote bind), optionally adding passkey sign-in for browsers.

## Safest path: local browser or SSH tunnel

On the sparkDash host:

```bash
docker compose up --build -d
```

Open `http://127.0.0.1:5555` locally. From another machine, create a tunnel:

```bash
ssh -N -L 5555:127.0.0.1:5555 user@sparkdash-host
```

Then open `http://127.0.0.1:5555` on the client. The dashboard remains loopback-only on the server.

## Shared remote access

Keep `BIND_HOST=127.0.0.1` and publish the loopback service through one of these authenticated front doors:

- an HTTPS reverse proxy that requires identity before proxying HTTP and WebSocket traffic;
- Tailscale Serve with tailnet identity/access policy.

The front door must proxy both `/api/*` and `/ws`, preserve WebSocket upgrades, and require authentication for every path. TLS without authentication is not sufficient.

Tailscale Serve needs nothing more. Behind a reverse proxy on a custom domain, list that domain in `SPARKDASH_ALLOWED_HOSTS` (comma-separated); a loopback bind refuses other sites and names it does not recognise, and the refusal page says which name to add.

A direct `BIND_HOST=0.0.0.0` bind without `SPARKDASH_TOKEN` is **open by default**: anyone who reaches it can read telemetry, change settings and power units off. Set a token for protected remote access, and `SPARKDASH_ALLOW_OPEN_REMOTE=0` to refuse startup when the token is missing.

## Passkey sign-in

With `SPARKDASH_TOKEN` set, the browser normally keeps the token in `localStorage` and sends it on every request. Passkey sign-in replaces that: the operator signs in with a passkey (Touch ID, Windows Hello, a phone or a security key) and the browser holds only an `HttpOnly`, `SameSite=Strict` session cookie. The token goes back to being the credential of scripts and Prometheus.

Turn it on by setting the origin the browser actually shows:

```bash
SPARKDASH_TOKEN=… SPARKDASH_PASSKEY_ORIGIN=https://spark.example.ts.net docker compose up --build -d
```

- **The origin must be a secure context bound to a hostname.** Browsers only run passkey ceremonies on `https://` or `http://localhost`, and a passkey cannot be bound to an IP address. `http://spark.lan:5555`, `http://127.0.0.1:5555` and `https://192.168.1.20` all refuse to start with a message naming `SPARKDASH_PASSKEY_ORIGIN`. Tailscale Serve (`tailscale serve --bg 5555`) is the least work; its name is accepted as a host automatically.
- **`SPARKDASH_TOKEN` is required.** Enrolling a passkey needs the token, so an origin without one refuses to start rather than offering a sign-in nothing can ever enrol for.
- **Enrol:** open the dashboard, choose **Sign in with the access token** once, then **Settings → Passkeys → Add a passkey**. Add a second device the same way. A session that a *passkey* established can list passkeys but not add or revoke them, so a stolen session cannot mint lasting access or lock the operator out.
- **Sessions** last `SPARKDASH_SESSION_TTL_DAYS` (default 30) from sign-in, survive restarts, and end server-side on **Sign out** or when their passkey is revoked. A cookie-authenticated change or WebSocket must come from the configured origin.
- **Rotating `SPARKDASH_TOKEN`** removes every passkey and session at the next start; enrol again with the new token. The store keeps only an scrypt fingerprint of the token, never the token.
- **Passkey-only:** `SPARKDASH_PASSKEY_ONLY=1` refuses the token everywhere once at least one passkey is enrolled — except GET/HEAD `/metrics`, so a Prometheus scraper keeps working. With nothing enrolled the token still works, so the flag cannot lock you out on its own. Keep a token-derived session while managing passkeys, or temporarily disable the flag and restart to establish a new management session.

State lives in `config/passkeys.sqlite` (mode `0600`, override with an absolute `PASSKEYS_DB_PATH`; Node 22.13+). SQLite transactions serialize the service and recovery CLI, so a concurrent request cannot undo a reset. A wrong location is fatal at startup; an unreadable/corrupt store fails closed for passkey operations but leaves bearer-token access available. Reset corrupt state on the host, then restart the service.

**Lost every passkey?** Recovery is on the host only — a network route that clears enrolment would let anyone un-enrol you and enrol themselves:

```bash
docker exec sparkDash node server/passkeyAdmin.js list
docker exec sparkDash node server/passkeyAdmin.js reset          # remove all passkeys and sessions
docker exec sparkDash node server/passkeyAdmin.js sign-out-all   # end sessions, keep passkeys
# container stopped:
docker compose run --rm sparkdash node server/passkeyAdmin.js reset
```

**What this does not change.** Unless `SPARKDASH_PASSKEY_ONLY=1`, anyone holding the token can still use the API directly, so a passkey improves how the browser handles credentials (no token in `localStorage`, per-device revocation, phishing resistance) rather than adding a boundary. And on a loopback bind, read-only REST requests stay open to whatever reaches the loopback port, exactly as before — behind Tailscale Serve that is your tailnet, so keep its access policy narrow.

## Existing Docker installations

Previous Compose files exposed `http://<host-ip>:5555`. After upgrading:

1. Leave `BIND_HOST` unset (or set it to `127.0.0.1`).
2. Recreate the service: `docker compose up --build -d`.
3. Use the SSH tunnel above immediately, or configure an authenticated reverse proxy/Tailscale Serve.

To recover from a mistaken non-loopback setting in one command:

```bash
BIND_HOST=127.0.0.1 docker compose up -d --force-recreate
```

## SSH key mount

Remote unit checks run inside the container. Mount one private key read-only at `/root/.ssh/id_ed25519`, or set `SSH_IDENTITY_FILE` to its in-container path. The host key file must be mode `600`:

```bash
chmod 600 "$HOME/.ssh/id_ed25519"
```

Startup preflight reports the bind/auth mode, config writability, secrets-key state, SSH identity state, and local collector mounts. Warnings describe degraded optional features and open remote binds; a missing token with `SPARKDASH_ALLOW_OPEN_REMOTE=0`, invalid passkey configuration, or an unwritable config is fatal.
