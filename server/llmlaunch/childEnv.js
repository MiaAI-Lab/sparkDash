/**
 * Environment for user scripts the dashboard runs on the local host (model
 * launchers, Hermes). The dashboard's own settings must not leak into them:
 * `PORT=5555` made a start.sh that honours `$PORT` try to bind sparkDash's port,
 * and SPARKDASH_TOKEN would be readable by every script and the processes it starts.
 */
const DASHBOARD_ENV = new Set([
  "PORT",
  "LLM_PORT",
  "BIND_HOST",
  "NODE_ENV",
  "DASHBOARD_TOKEN",
  "SSH_IDENTITY_FILE",
  "HOST_PROC_PATH",
  "HOST_SYS_PATH",
  "HOST_ROOT_PATH",
]);

export function scrubbedChildEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (DASHBOARD_ENV.has(key)) continue;
    if (key.startsWith("SPARKDASH_") || key.startsWith("POLL_INTERVAL_")) continue;
    out[key] = value;
  }
  return out;
}
