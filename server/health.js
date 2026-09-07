import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import { configuredToken, requireRemoteAuth } from "./auth.js";

export function evaluateHealth({ bindHost, configWritable, secretsKeyPresent, sshIdentityPresent }) {
  const remote = requireRemoteAuth(bindHost);
  const token = Boolean(configuredToken());
  const errors = [];
  const warnings = [];
  if (remote && !token) errors.push("Remote bind requires SPARKDASH_TOKEN");
  if (!configWritable) errors.push("Config directory is not writable");
  if (!secretsKeyPresent) warnings.push("Secrets key is not present yet");
  if (!sshIdentityPresent) warnings.push("SSH identity is not mounted");
  return {
    ok: errors.length === 0,
    bindHost,
    authMode: token ? "bearer" : remote ? "required-missing" : "loopback-open",
    errors,
    warnings,
  };
}

export function inspectHealth(bindHost) {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  let writable = true;
  try { fs.accessSync(configDir, fs.constants.W_OK); } catch { writable = false; }
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  return evaluateHealth({
    bindHost,
    configWritable: writable,
    secretsKeyPresent: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(keyFile),
    sshIdentityPresent: fs.existsSync(identity),
  });
}
