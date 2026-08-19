# DeepSeek Harness (dsh) Occupancy Helper

A small HTTP server that polls the dsh web JSON-RPC API and serves session occupancy data for SparkDash URL attach.

## Requirements

- Node.js 22+
- dsh web profile running (default `http://127.0.0.1:3080`)

## Setup

Run on the machine that hosts dsh web (e.g. theshop):

```bash
DSH_OCCUPANCY_TOKEN="$(openssl rand -hex 32)" \
DSH_OCCUPANCY_BIND="$(tailscale ip -4)" \
DSH_WEB_URL="http://127.0.0.1:3080" \
node scripts/dsh-occupancy-helper/index.js
```

The helper prints its URL. In SparkDash:

1. Any LLM card → Settings → Occupancy sources → DeepSeek Harness → URL
2. Paste the helper URL and `DSH_OCCUPANCY_TOKEN`
3. Check and Save

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DSH_OCCUPANCY_TOKEN` | (none) | Bearer token for auth. Required when binding to a non-loopback address. |
| `DSH_OCCUPANCY_BIND` | `127.0.0.1` | Bind address. Use your Tailscale IP for remote access. |
| `DSH_OCCUPANCY_PORT` | `8791` | Listen port. |
| `DSH_OCCUPANCY_PATH` | `/occupancy` | URL path for the occupancy endpoint. |
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | dsh web API base URL. |

## How it works

The helper polls dsh web's `POST /api/session.list` endpoint, filters out blank sessions (no turn has run), enriches each with `POST /api/session.models` for provider/model info, and maps to projector-input rows. Results are cached for 2 seconds.

Sessions appear in a "DeepSeek Harness" lane on the SparkDash occupancy panel with title, running state, token usage, and context pressure. No spark-card projection in v1 (dsh API exposes provider name but not baseURL).

## Security

- Token auth via `Authorization: Bearer <token>` header (timing-safe comparison)
- Refuses to bind `0.0.0.0` or `::`
- Refuses non-loopback bind without a token
- No session transcripts or credentials are read — only the dsh web API's session list and model metadata
