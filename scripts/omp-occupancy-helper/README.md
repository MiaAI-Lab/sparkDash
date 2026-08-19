# oh-my-pi (omp) occupancy helper

sparkDash polls this process over LAN or Tailscale to show omp session occupancy. It reads local `~/.omp/agent/sessions/*.jsonl` and `~/.omp/agent/models.yml` — never transcripts, credentials, or databases.

In the dashboard: any **LLM card → Settings (gear) → Occupancy sources → oh-my-pi → URL**.

## Run (from the sparkDash checkout)

Node 22.13+. Do **not** bind `0.0.0.0`.

```bash
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8789/occupancy\nToken: %s\n' "$BIND" "$TOKEN"
OMP_OCCUPANCY_BIND="$BIND" OMP_OCCUPANCY_TOKEN="$TOKEN" \
  node scripts/omp-occupancy-helper/index.js
```

Leave it running. Paste the printed URL and token into sparkDash, then **Check** and **Save occupancy** (not the LLM port Save).

Loopback-only (dashboard on the same host as omp): skip the helper and use mode **Local**.

## Reach sparkDash from a workstation

A reachable (non-loopback) bind **requires** `OMP_OCCUPANCY_TOKEN`. Either:

1. Bind a **tailnet or LAN IP** with a token (command above).
2. **Tailscale Serve**: keep the helper on `127.0.0.1` and serve the port on the tailnet.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OMP_OCCUPANCY_BIND` | `127.0.0.1` | Listen address |
| `OMP_OCCUPANCY_PORT` | `8789` | Listen port |
| `OMP_OCCUPANCY_PATH` | `/occupancy` | GET path |
| `OMP_OCCUPANCY_TOKEN` | empty | If set, require `Authorization: Bearer …` |
| `OMP_STATE_DIR` | `~/.omp` | State root (contains `agent/sessions/`) |
| `OMP_CONFIG_DIR` | `~/.omp/agent` | Config dir (contains `models.yml`) |

The helper reads JSONL session files and the provider map only. Missing state returns **HTTP 503**, not an empty list.

Response shape:

```json
{ "found": 2, "rows": [{ "source": "omp", "handle": "…", "originHost": "192.168.4.117", "originPort": 8888, "midTurn": "unknown" }] }
```

## What it reads

- `~/.omp/agent/sessions/**/*.jsonl` — session metadata (title, model, timestamps)
- `~/.omp/agent/models.yml` — provider `baseUrl` values for origin mapping

It does **not** read message transcripts, thinking content, API keys (only `baseUrl` from `models.yml`), or any database.
