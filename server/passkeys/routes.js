/**
 * Passkey sign-in, enrolment and revocation routes.
 *
 * Registered ahead of the auth middleware so the sign-in routes answer a browser
 * that holds no credential yet. EXEMPT_ROUTES is that whole surface, enumerated
 * exactly; every other route here authenticates for itself, and the enrol and
 * revoke routes also require the token's authority (see auth.authenticate).
 *
 * No route clears or bypasses enrolment: recovery is passkeyAdmin.js on the host.
 */
import { createHash } from "node:crypto";
import {
  authenticate,
  configuredToken,
  createHostGuardMiddleware,
  extractBearer,
  passkeysEnabled,
  tokenRefused,
  tokensEqual,
} from "../auth.js";
import { passkeyOrigin, passkeyRpId, sessionTtlMs } from "./settings.js";
import { clearSessionCookie, sessionToken, setSessionCookie } from "./session.js";
import * as store from "./store.js";

/** Loaded on first use, so a disarmed install whose image predates the dependency still starts. */
const webauthn = () => import("@simplewebauthn/server");

/** Routes a caller with no credential may reach. Exact, never a prefix. */
export const EXEMPT_ROUTES = Object.freeze([
  "POST /api/auth/passkey/login/options",
  "POST /api/auth/passkey/login/verify",
  "POST /api/auth/session/token",
  "POST /api/auth/logout",
]);

const AUTHENTICATION = "authentication";
const REGISTRATION = "registration";
/** One operator: a fixed user handle, so a second enrolment is the same account. */
const USER_ID = createHash("sha256").update("sparkdash-operator").digest();

const NOT_ENABLED = "Passkey sign-in is not enabled on this server (set SPARKDASH_PASSKEY_ORIGIN and SPARKDASH_TOKEN).";
const CEREMONY_EXPIRED = "That sign-in took too long or was already used. Start again.";
const LOGIN_REFUSED = "That passkey could not be verified.";
const ENROL_REFUSED = "That authenticator's response could not be verified.";
const KEY_REQUIRED =
  "Adding or removing passkeys needs the access token: sign in with SPARKDASH_TOKEN (not a passkey) and try again.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The challenge a ceremony response was signed over, from its clientDataJSON. */
export function challengeOf(response) {
  try {
    const json = Buffer.from(String(response?.response?.clientDataJSON || ""), "base64url").toString("utf8");
    const challenge = JSON.parse(json)?.challenge;
    return typeof challenge === "string" ? challenge : "";
  } catch {
    return "";
  }
}

/** 404 unless armed, so a disarmed server serves exactly as before. */
function requireEnabled(res) {
  if (passkeysEnabled()) return true;
  res.status(404).json({ error: NOT_ENABLED });
  return false;
}

/** Authenticated (any credential), and — when `manage` — carrying the token's authority. */
function requireCaller(req, res, { manage }) {
  const result = authenticate(req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  if (manage && !result.keyAuthority) {
    res.status(403).json({ error: KEY_REQUIRED });
    return null;
  }
  return result;
}

/** A store write failed: say so instead of looking like success. */
function storeFailure(res, err) {
  console.error(`[passkeys] store write failed: ${err.message}`);
  res.status(500).json({ error: `Could not save passkey state: ${err.message}` });
}

export function registerPasskeyRoutes(app) {
  const hostGuard = createHostGuardMiddleware();

  // ─── Sign-in (exempt) ────────────────────────────────

  // Identical whether or not anything is enrolled: discoverable credentials
  // mean no allowCredentials list, so nothing about enrolment is disclosed.
  app.post("/api/auth/passkey/login/options", hostGuard, async (_req, res) => {
    if (!requireEnabled(res)) return;
    try {
      const options = await (await webauthn()).generateAuthenticationOptions({
        rpID: passkeyRpId(),
        userVerification: "required",
        allowCredentials: [],
        timeout: 60_000,
      });
      store.issueChallenge(AUTHENTICATION, options.challenge);
      res.json({ options });
    } catch (err) {
      storeFailure(res, err);
    }
  });

  app.post("/api/auth/passkey/login/verify", hostGuard, async (req, res) => {
    if (!requireEnabled(res)) return;
    const response = req.body?.response;
    const challenge = challengeOf(response);
    // A body naming no live challenge is refused cheaply and charged nothing, so
    // free garbage cannot raise the operator's own sign-in delay.
    let spent = false;
    try {
      spent = store.consumeChallenge(challenge, AUTHENTICATION);
    } catch (err) {
      return storeFailure(res, err);
    }
    if (!spent) return res.status(400).json({ error: CEREMONY_EXPIRED });

    const delay = store.loginBackoffMs();
    if (delay > 0) await sleep(delay);

    const credential = store.findCredential(response?.id);
    let verification = null;
    if (credential) {
      try {
        verification = await (await webauthn()).verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: passkeyOrigin(),
          expectedRPID: passkeyRpId(),
          credential: {
            id: credential.credentialId,
            publicKey: Buffer.from(credential.publicKey, "base64url"),
            counter: credential.counter,
            transports: credential.transports,
          },
          requireUserVerification: true,
        });
      } catch {
        verification = null;
      }
    }
    try {
      if (!verification?.verified) {
        store.recordFailure();
        return res.status(401).json({ error: LOGIN_REFUSED });
      }
      const session = store.completeAuthentication(credential.id, verification.authenticationInfo.newCounter, sessionTtlMs(), spent);
      if (!session) return res.status(401).json({ error: LOGIN_REFUSED });
      setSessionCookie(res, session);
    } catch (err) {
      return storeFailure(res, err);
    }
    res.json({ ok: true, session: { method: "passkey", canManage: false } });
  });

  // The browser exchanges the token for a session once, instead of keeping it in
  // localStorage. The session grants exactly what the token already grants.
  app.post("/api/auth/session/token", hostGuard, (req, res) => {
    if (!requireEnabled(res)) return;
    const provided = extractBearer(req);
    if (!provided || !tokensEqual(provided, configuredToken())) {
      return res.status(401).json({ error: "The server rejected this token." });
    }
    if (tokenRefused(req)) {
      return res.status(403).json({ error: "This server accepts only passkeys for sign-in (SPARKDASH_PASSKEY_ONLY)." });
    }
    try {
      setSessionCookie(res, store.createTokenSession(sessionTtlMs()));
    } catch (err) {
      return storeFailure(res, err);
    }
    res.json({ ok: true, session: { method: "token", canManage: true } });
  });

  // Destroys the session server-side; clearing the cookie alone would not.
  app.post("/api/auth/logout", hostGuard, (req, res) => {
    if (!passkeysEnabled()) return res.json({ ok: true });
    if (req.headers.origin && req.headers.origin !== passkeyOrigin()) {
      return res.status(403).json({ error: "Cross-origin request refused" });
    }
    try {
      store.destroySession(sessionToken(req));
    } catch (err) {
      return storeFailure(res, err);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ─── Management (authenticated) ──────────────────────

  app.get("/api/auth/passkeys", hostGuard, (req, res) => {
    if (!requireEnabled(res)) return;
    const caller = requireCaller(req, res, { manage: false });
    if (!caller) return;
    try {
      res.json({ canManage: caller.keyAuthority, passkeys: store.listCredentials() });
    } catch (err) {
      storeFailure(res, err);
    }
  });

  app.post("/api/auth/passkey/register/options", hostGuard, async (req, res) => {
    if (!requireEnabled(res) || !requireCaller(req, res, { manage: true })) return;
    try {
      const options = await (await webauthn()).generateRegistrationOptions({
        rpName: "sparkDash",
        rpID: passkeyRpId(),
        userID: USER_ID,
        userName: "operator",
        userDisplayName: "sparkDash operator",
        attestationType: "none",
        excludeCredentials: store.credentialDescriptors(),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120_000,
      });
      store.issueChallenge(REGISTRATION, options.challenge);
      res.json({ options });
    } catch (err) {
      storeFailure(res, err);
    }
  });

  app.post("/api/auth/passkey/register/verify", hostGuard, async (req, res) => {
    if (!requireEnabled(res)) return;
    const caller = requireCaller(req, res, { manage: true });
    if (!caller) return;
    const response = req.body?.response;
    const challenge = challengeOf(response);
    let spent = false;
    try {
      spent = store.consumeChallenge(challenge, REGISTRATION);
    } catch (err) {
      return storeFailure(res, err);
    }
    if (!spent) return res.status(400).json({ error: CEREMONY_EXPIRED });
    let verification;
    try {
      verification = await (await webauthn()).verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: passkeyOrigin(),
        expectedRPID: passkeyRpId(),
        requireUserVerification: true,
      });
    } catch {
      verification = null;
    }
    if (!verification?.verified || !verification.registrationInfo) return res.status(400).json({ error: ENROL_REFUSED });
    const { credential } = verification.registrationInfo;
    try {
      const passkey = store.addCredential({
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? response?.response?.transports,
        label: req.body?.label,
      }, { generation: spent, sessionToken: caller.mode === "session" ? sessionToken(req) : null });
      console.log(`[passkeys] enrolled passkey ${passkey.id}${passkey.label ? ` (${passkey.label})` : ""}`);
      res.json({ ok: true, passkey });
    } catch (err) {
      if (err instanceof store.DuplicateCredentialError) return res.status(409).json({ error: err.message });
      if (err instanceof store.AuthorityExpiredError) return res.status(403).json({ error: err.message });
      storeFailure(res, err);
    }
  });

  app.delete("/api/auth/passkeys/:id", hostGuard, (req, res) => {
    if (!requireEnabled(res) || !requireCaller(req, res, { manage: true })) return;
    let removed;
    try {
      removed = store.removeCredential(String(req.params.id));
    } catch (err) {
      return storeFailure(res, err);
    }
    if (!removed) return res.status(404).json({ error: "No such passkey." });
    console.log(`[passkeys] revoked passkey ${req.params.id}`);
    res.json({ ok: true });
  });
}
