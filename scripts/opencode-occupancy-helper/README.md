# OpenCode occupancy helper

sparkDash on john polls this process over LAN or Tailscale. It does **not** talk to OpenCode’s own HTTP server.

## Run (from the sparkDash checkout)

```bash
node scripts/opencode-occupancy-helper/index.js
```

Default listen is **loopback** `127.0.0.1:8788`, path `/occupancy`.

## Point sparkDash at it

Settings → Session sources → OpenCode → mode **URL**.

- URL: `http://<this-host>:8788/occupancy`
- Token: the same value as `OPENCODE_OCCUPANCY_TOKEN` (optional on loopback; set it if john can reach this bind)
- Start this helper **before** Check

## Reach john from a workstation

Do **not** bind `0.0.0.0`. Either:

1. **Tailscale Serve** (recommended): keep the helper on loopback and serve the port on the tailnet.
2. Bind a **tailnet IP**: `OPENCODE_OCCUPANCY_BIND=100.x.y.z OPENCODE_OCCUPANCY_TOKEN=… node scripts/opencode-occupancy-helper/index.js`

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_OCCUPANCY_BIND` | `127.0.0.1` | Listen address |
| `OPENCODE_OCCUPANCY_PORT` | `8788` | Listen port |
| `OPENCODE_OCCUPANCY_PATH` | `/occupancy` | GET path |
| `OPENCODE_OCCUPANCY_TOKEN` | empty | If set, require `Authorization: Bearer …` |
| `OPENCODE_DATA_DIR` | `~/.local/share/opencode` | Session db root (`opencode.db`) |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Provider map (`opencode.jsonc` then `opencode.json`) |

The helper reads the OpenCode **session** table only. Missing state returns **HTTP 503**, not an empty list.

Response shape:

```json
{ "found": 2, "rows": [{ "source": "opencode", "handle": "…", "originHost": "john", "originPort": 8888, "midTurn": "unknown" }] }
```
