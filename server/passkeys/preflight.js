import { createRequire } from "node:module";
import { ORIGIN_VAR, PasskeyConfigError, passkeyOnly, passkeyOrigin } from "./settings.js";
import { armStore, storeLocationProblem } from "./store.js";

/** The verifier is loaded lazily (routes.js); an armed server must know it is there. */
function verifierMissing() {
  try {
    createRequire(import.meta.url).resolve("@simplewebauthn/server");
    return false;
  } catch {
    return true;
  }
}

/**
 * Why passkey sign-in, as configured, cannot work — or null when it can or is off.
 * Each case is fatal at startup: "armed but nothing can ever be enrolled" is the
 * one state this feature must never serve silently.
 * @param {{ tokenConfigured: boolean }} input
 */
export function passkeyPreflightProblem({ tokenConfigured }) {
  let origin;
  try {
    origin = passkeyOrigin();
  } catch (err) {
    if (err instanceof PasskeyConfigError) return err.message;
    throw err;
  }
  if (!origin) return null;
  if (!tokenConfigured) {
    return `${ORIGIN_VAR} is set but SPARKDASH_TOKEN is not: enrolling a passkey requires the token, so nothing could ever be enrolled. Set SPARKDASH_TOKEN, or unset ${ORIGIN_VAR}.`;
  }
  if (verifierMissing()) {
    return `${ORIGIN_VAR} is set but @simplewebauthn/server is not installed — this image predates passkey sign-in. Rebuild it (docker compose up --build -d), or unset ${ORIGIN_VAR}.`;
  }
  try {
    createRequire(import.meta.url)("node:sqlite");
  } catch {
    return `${ORIGIN_VAR} requires Node 22.13+ with node:sqlite available — upgrade Node or rebuild the image, or unset ${ORIGIN_VAR}.`;
  }
  return storeLocationProblem();
}

/** Bind the store to the token (clearing it if the token changed) and say so. */
export function armPasskeys(token) {
  if (!armStore(token)) return;
  console.log(
    `[sparkDash] passkey sign-in armed for ${passkeyOrigin()}${passkeyOnly() ? " (passkey-only once a passkey is enrolled)" : ""}`
  );
}
