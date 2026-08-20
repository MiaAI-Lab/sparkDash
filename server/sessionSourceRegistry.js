/**
 * Session source kind registry (metadata only).
 * Collect/diagnose stay in occupancyPoller and sessionSourceHealth so this
 * module never imports OpenClawSessions or HermesSessions (ESM cycle).
 */

function trimmedEnv(value, fallback) {
  return value && String(value).trim() ? String(value).trim() : fallback;
}

const KINDS = Object.freeze([
  Object.freeze({
    id: "openclaw",
    label: "OpenClaw",
    description: "Gateway state directory or HTTP API",
    urlPlaceholder: "http://127.0.0.1:18789",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OPENCLAW_STATE_DIR, "~/.openclaw");
    },
  }),
  Object.freeze({
    id: "hermes",
    label: "Hermes Agent",
    description: "Hermes home directory or HTTP API",
    urlPlaceholder: "http://127.0.0.1:8787",
    usesUsername: true,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.HERMES_HOME, "~/.hermes");
    },
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    description: "Local SQLite database or remote helper",
    urlPlaceholder: "http://127.0.0.1:8788/occupancy",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OPENCODE_DATA_DIR, "~/.local/share/opencode");
    },
    conventionalConfigDir(env = process.env) {
      return trimmedEnv(env?.OPENCODE_CONFIG_DIR, "~/.config/opencode");
    },
    helperHuman: `BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8788/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
OPENCODE_OCCUPANCY_BIND="$BIND" OPENCODE_OCCUPANCY_TOKEN="$TOKEN" node scripts/opencode-occupancy-helper/index.js`,
    helperAgent: `# Run on the machine that has OpenCode installed.
# Requires Node 22.13+ and a sparkDash checkout.
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8788/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
OPENCODE_OCCUPANCY_BIND="$BIND" OPENCODE_OCCUPANCY_TOKEN="$TOKEN" node scripts/opencode-occupancy-helper/index.js
# After the helper prints URL and Token, relay them back to the user
# so they can paste them into the sparkDash wizard.`,
  }),
  Object.freeze({
    id: "omp",
    label: "oh-my-pi",
    description: "Local state directory or remote helper",
    urlPlaceholder: "http://127.0.0.1:8789/occupancy",
    usesUsername: false,
    conventionalStateDir(env = process.env) {
      return trimmedEnv(env?.OMP_STATE_DIR, "~/.omp");
    },
    conventionalConfigDir(env = process.env) {
      return trimmedEnv(env?.OMP_CONFIG_DIR, "~/.omp/agent");
    },
    helperHuman: `BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8789/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
OMP_OCCUPANCY_BIND="$BIND" OMP_OCCUPANCY_TOKEN="$TOKEN" node scripts/omp-occupancy-helper/index.js`,
    helperAgent: `# Run on the machine that has oh-my-pi (~/.omp) installed.
# Requires Node 22.13+ and a sparkDash checkout.
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8789/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
OMP_OCCUPANCY_BIND="$BIND" OMP_OCCUPANCY_TOKEN="$TOKEN" node scripts/omp-occupancy-helper/index.js
# After the helper prints URL and Token, relay them back to the user
# so they can paste them into the sparkDash wizard.`,
  }),
  Object.freeze({
    id: "dsh",
    label: "DeepSeek Harness",
    description: "Remote web API — requires a helper",
    urlPlaceholder: "http://127.0.0.1:8791/occupancy",
    usesUsername: false,
    remoteOnly: true,
    helperHuman: `BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8791/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
DSH_OCCUPANCY_TOKEN="$TOKEN" DSH_OCCUPANCY_BIND="$BIND" DSH_WEB_URL="http://127.0.0.1:3080" node scripts/dsh-occupancy-helper/index.js`,
    helperAgent: `# Run on the machine that hosts dsh web (default http://127.0.0.1:3080).
# Requires Node 22.13+ and a sparkDash checkout.
BIND="$(tailscale ip -4 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
TOKEN="$(openssl rand -hex 32)"
printf 'URL:   http://%s:8791/occupancy\\nToken: %s\\n' "$BIND" "$TOKEN"
DSH_OCCUPANCY_TOKEN="$TOKEN" DSH_OCCUPANCY_BIND="$BIND" DSH_WEB_URL="http://127.0.0.1:3080" node scripts/dsh-occupancy-helper/index.js
# After the helper prints URL and Token, relay them back to the user
# so they can paste them into the sparkDash wizard.`,
  }),
]);

export function sessionSourceKinds() {
  return KINDS.slice();
}

export function sessionSourceIds() {
  return KINDS.map((kind) => kind.id);
}

export function kindById(id) {
  const key = String(id ?? "");
  return KINDS.find((kind) => kind.id === key) ?? null;
}

export function conventionalStateDir(id, env = process.env) {
  const kind = kindById(id);
  if (kind && typeof kind.conventionalStateDir === "function") {
    return kind.conventionalStateDir(env);
  }
  return "";
}

export function conventionalConfigDir(id, env = process.env) {
  const kind = kindById(id);
  if (kind && typeof kind.conventionalConfigDir === "function") {
    return kind.conventionalConfigDir(env);
  }
  return "";
}

export const SOURCE_IDS = Object.freeze(sessionSourceIds());
