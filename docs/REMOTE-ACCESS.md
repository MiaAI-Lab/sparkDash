# Remote access

sparkDash includes administrative actions such as credential changes, benchmarks, updates, and power controls. Its application API does not authenticate direct clients in this release, so the server binds to `127.0.0.1` and refuses non-loopback startup.

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

Direct `BIND_HOST=0.0.0.0` requires `SPARKDASH_TOKEN`. Without a token, remote bind fails closed for mutations and WebSocket telemetry. A firewall-only or “trusted LAN” deployment is not a supported substitute.

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

Startup preflight reports the bind/auth mode, config writability, secrets-key state, SSH identity state, and local collector mounts. Warnings describe degraded optional features; an unsafe bind or unwritable config is fatal.
