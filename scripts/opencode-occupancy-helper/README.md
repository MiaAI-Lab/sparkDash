# OpenCode occupancy helper

sparkDash polls this process over LAN or Tailscale. It does **not** talk to OpenCode’s own HTTP server.

In the dashboard: any **LLM card → Settings (gear) → Occupancy sources → OpenCode → URL**.
That panel also has a copy-paste start command.

## Run (from the sparkDash checkout)

Node 22+. Do **not** bind `0.0.0.0`.

```bash
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8788/occupancy\nToken: %s\n' "$BIND" "$TOKEN"
OPENCODE_OCCUPANCY_BIND="$BIND" OPENCODE_OCCUPANCY_TOKEN="$TOKEN" \
  node scripts/opencode-occupancy-helper/index.js
```

Leave it running. Paste the printed URL and token into sparkDash, then **Check** and **Save occupancy** (not the LLM port Save).

Loopback-only (dashboard on the same host as OpenCode): skip the helper and use mode **Local**.

## Reach sparkDash from a workstation

A reachable (non-loopback) bind **requires** `OPENCODE_OCCUPANCY_TOKEN`. Either:

1. Bind a **tailnet or LAN IP** with a token (command above).
2. **Tailscale Serve**: keep the helper on `127.0.0.1` and serve the port on the tailnet.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_OCCUPANCY_BIND` | `127.0.0.1` | Listen address |
| `OPENCODE_OCCUPANCY_PORT` | `8788` | Listen port |
| `OPENCODE_OCCUPANCY_PATH` | `/occupancy` | GET path |
| `OPENCODE_OCCUPANCY_TOKEN` | empty | If set, require `Authorization: Bearer …` |
| `OPENCODE_DATA_DIR` | `~/.local/share/opencode` | Session db root (`opencode.db`) |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Provider map (`opencode.jsonc` then `opencode.json`) |

macOS: if Check returns **503**, set `OPENCODE_DATA_DIR` to the folder that contains `opencode.db` (often `~/Library/Application Support/opencode`).

The helper reads the OpenCode **session** table only. Missing state returns **HTTP 503**, not an empty list.

Response shape:

```json
{ "found": 2, "rows": [{ "source": "opencode", "handle": "…", "originHost": "john", "originPort": 8888, "midTurn": "unknown" }] }
```
