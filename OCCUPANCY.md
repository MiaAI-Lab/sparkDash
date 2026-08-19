# Session occupancy

sparkDash shows active coding-agent sessions on each Spark's LLM card. Sessions are matched to Sparks by the LLM host:port they hit — so a session using a model on `mama:4000` shows on mama's port-4000 card.

## Supported sources

| Source | Local mode | URL mode | State-dir mode |
|--------|-----------|----------|----------------|
| **OpenClaw** | `~/.openclaw` (or gateway on same host) | Gateway URL + token | Custom state dir |
| **Hermes Agent** | `~/.hermes` | Dashboard URL + token | Custom state dir |
| **OpenCode** | `~/.local/share/opencode` (reads `opencode.db`) | Helper URL + token | Custom state dir |
| **oh-my-pi (omp)** | `~/.omp` (reads JSONL + `models.yml`) | Helper URL + token | Custom state dir |

## Configure attaches

Dashboard-wide — set once on any LLM card:

1. **Any LLM card → Settings (gear) → Occupancy sources**
2. Toggle a source on, pick a mode, fill in URL/state-dir/token as needed
3. **Check** to test connectivity
4. **Save occupancy** (separate from the LLM port Save)

Sessions land on the Spark whose `llmPorts` match the session's origin host:port.

## Session age filter

**Settings → Occupancy session age limit** (default: 12 hours). Sessions older than this are hidden from the dashboard. Set to `0` to show all sessions regardless of age.

## Local mode (same host as sparkDash)

When sparkDash runs on the same machine as the agent, use **Local** mode. No helper needed — the collector reads the state directory directly.

For Docker deployments with `HOST_ROOT_PATH=/host/root`, local mode reads through the host root mount.

## URL mode (remote machine)

When the agent runs on a different machine, run a helper on that machine and attach via URL.

### OpenCode helper

On the OpenCode machine (Node 22+, sparkDash checkout):

```bash
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8788/occupancy\nToken: %s\n' "$BIND" "$TOKEN"
OPENCODE_OCCUPANCY_BIND="$BIND" OPENCODE_OCCUPANCY_TOKEN="$TOKEN" \
  node scripts/opencode-occupancy-helper/index.js
```

Full env and macOS path notes: [`scripts/opencode-occupancy-helper/README.md`](./scripts/opencode-occupancy-helper/README.md)

### oh-my-pi (omp) helper

On the omp machine (Node 22+, sparkDash checkout):

```bash
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8789/occupancy\nToken: %s\n' "$BIND" "$TOKEN"
OMP_OCCUPANCY_BIND="$BIND" OMP_OCCUPANCY_TOKEN="$TOKEN" \
  node scripts/omp-occupancy-helper/index.js
```

Full env notes: [`scripts/omp-occupancy-helper/README.md`](./scripts/omp-occupancy-helper/README.md)

### Security rules for helpers

- **Never bind `0.0.0.0`** — the helpers refuse it. Use a Tailscale or LAN IP.
- **Token required** for non-loopback binds. The helper refuses to start without one.
- Helpers serve **metadata only** — session handles, model origins, timestamps. No transcripts, no API keys, no credentials.
- Response is cached for 2 seconds to avoid re-reading files on every poll.

### Running both helpers on one machine

OpenCode and omp helpers use different ports (8788 and 8789), so they can run side by side:

```bash
# Terminal 1 — OpenCode
OPENCODE_OCCUPANCY_TOKEN="token-oc" OPENCODE_OCCUPANCY_BIND="$(tailscale ip -4)" \
  node scripts/opencode-occupancy-helper/index.js

# Terminal 2 — omp
OMP_OCCUPANCY_TOKEN="token-omp" OMP_OCCUPANCY_BIND="$(tailscale ip -4)" \
  node scripts/omp-occupancy-helper/index.js
```

Then add two URL attaches in sparkDash (one OpenCode, one oh-my-pi), each pointing at the same IP on the respective port.

## Multiple attaches of the same kind

Click **Add** next to a source kind to attach more than one instance (e.g., OpenCode on both your Mac and your workstation). Each attach gets a unique ID (`opencode-2`, `opencode-3`, etc.) and can be checked and toggled independently.

## How origin matching works

Each session has an `originHost` and `originPort` derived from the provider's `baseUrl`:

- OpenClaw: provider `baseUrl` from the gateway payload
- Hermes: provider `baseUrl` from the dashboard API
- OpenCode: provider `baseURL` from `opencode.jsonc`/`opencode.json`
- omp: provider `baseUrl` from `~/.omp/agent/models.yml`

The projector matches sessions to Sparks by comparing `originHost:originPort` against each Spark's `llmPorts` and listen IPs. If a Spark has multiple LLM ports, sessions show on the port they actually hit.

## LiteLLM note

If you route models through LiteLLM (e.g., `kalliope` on port 4000), set the LLM API key in sparkDash so the `/v1/models` probe authenticates. LiteLLM without a database returns `400` on `/v1/models` without a key, which sparkDash interprets as "unreachable." With the key, all routed models appear on the single LiteLLM port — no need to expose the raw backend port separately.
