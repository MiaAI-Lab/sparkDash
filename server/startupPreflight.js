import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";

export function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host || "");
}

export function evaluateStartupPreflight(input) {
  const loopback = isLoopbackHost(input.bindHost);
  const errors = [];
  const warnings = [];
  if (!loopback && !input.tokenConfigured) {
    errors.push(
      `Remote bind ${input.bindHost} requires SPARKDASH_TOKEN. Keep BIND_HOST=127.0.0.1, or set SPARKDASH_TOKEN and use an SSH tunnel, authenticated TLS reverse proxy, or Tailscale Serve.`
    );
  }
  if (!input.configWritable) errors.push("Config directory is not writable; fix the config volume ownership/permissions.");
  if (!input.secretsKey?.present) warnings.push("No secrets key exists yet; one will be created when the secrets store is first used. Back it up with the config directory.");
  if (!input.sshIdentity?.configured) warnings.push("No SSH identity is configured; remote key-auth units will be unavailable.");
  if (input.sshIdentity?.configured && input.sshIdentity.safePermissions === false) {
    warnings.push("SSH identity permissions are too open; set the private key to mode 600.");
  }
  if (!input.localCollectors?.available) warnings.push("Local host metrics are unavailable; verify /proc and /sys host mounts.");
  return {
    fatal: errors.length > 0,
    authMode: loopback ? "loopback-only" : input.tokenConfigured ? "bearer" : "required-missing",
    errors,
    warnings,
  };
}

function pathWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectStartupPreflight(bindHost) {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  let identityMode = null;
  try {
    identityMode = fs.statSync(identity).mode & 0o777;
  } catch {
    identityMode = null;
  }
  return evaluateStartupPreflight({
    bindHost,
    tokenConfigured: Boolean(process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN),
    configWritable: pathWritable(configDir),
    secretsKey: {
      present: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(keyFile),
      source: process.env.SPARKDASH_SECRETS_KEY ? "environment" : "file",
    },
    sshIdentity: {
      configured: identityMode != null,
      path: identity,
      safePermissions: identityMode == null ? null : (identityMode & 0o077) === 0,
    },
    localCollectors: {
      available: fs.existsSync(path.join(HOST_PATHS.PROC, "meminfo")) && fs.existsSync(HOST_PATHS.SYS),
    },
  });
}

export function logStartupPreflight(preflight, bindHost, port) {
  console.log(`[sparkDash] preflight: bind=${bindHost}:${port} auth=${preflight.authMode}`);
  for (const warning of preflight.warnings) console.warn(`[sparkDash] preflight warning: ${warning}`);
  for (const error of preflight.errors) console.error(`[sparkDash] preflight error: ${error}`);
}
