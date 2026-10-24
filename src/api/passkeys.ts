/**
 * Passkey sign-in and enrolment (server: /api/auth/passkey/*, /api/auth/session/token,
 * /api/auth/logout, /api/auth/passkeys).
 *
 * A successful sign-in leaves an HttpOnly session cookie that same-origin fetch
 * and the WebSocket send by themselves, so a signed-in browser needs no stored
 * token. Every sign-in and sign-out emits notifySessionChange so the socket
 * reconnects and the app reloads what the old credentials could not read.
 */

import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { authHeaders, clearToken, notifySessionChange, parseSession, type AuthSession } from "./authToken";

export interface Passkey {
  id: string;
  label: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp, or null when never used to sign in. */
  lastUsedAt: string | null;
}

export interface PasskeyList {
  /** This browser may enrol and revoke (token authority). */
  canManage: boolean;
  passkeys: Passkey[];
}

/** The server refused a passkey/session request; `message` is its `{ error }` text. */
export class PasskeyRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PasskeyRequestError";
    this.status = status;
  }
}

/** The user dismissed the browser's passkey prompt, or it timed out. Not a failure to report loudly. */
export class PasskeyCancelledError extends Error {
  constructor() {
    super("The passkey prompt was cancelled or timed out.");
    this.name = "PasskeyCancelledError";
  }
}

export function isPasskeyCancelled(err: unknown): err is PasskeyCancelledError {
  return err instanceof PasskeyCancelledError;
}

async function request<T>(
  path: string,
  { method = "GET", body, headers }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    if (res.ok) throw new Error("The server did not return a JSON authentication response.");
  }
  if (!res.ok) {
    const error = (data as { error?: unknown } | null)?.error;
    throw new PasskeyRequestError(res.status, typeof error === "string" && error ? error : `HTTP ${res.status}`);
  }
  return data as T;
}

/** Run a WebAuthn ceremony, turning a user cancel / timeout into PasskeyCancelledError. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelledError();
    throw err;
  }
}

export async function signInWithPasskey(): Promise<AuthSession> {
  const { options } = await request<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    "/api/auth/passkey/login/options",
    { method: "POST", body: {} }
  );
  const response = await ceremony(() => startAuthentication({ optionsJSON: options }));
  const data = await request<{ session?: unknown }>("/api/auth/passkey/login/verify", {
    method: "POST",
    body: { response },
  });
  const session = parseSession(data?.session);
  if (!session || session.method !== "passkey") throw new Error("The server did not establish a passkey session.");
  clearToken();
  notifySessionChange(session);
  return session;
}

/**
 * Exchange the access token for a session cookie. The token is not kept: the
 * cookie carries the authority, so any stored copy is cleared.
 */
export async function signInWithToken(token: string): Promise<AuthSession> {
  const data = await request<{ session?: unknown }>("/api/auth/session/token", {
    method: "POST",
    body: {},
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
  const session = parseSession(data?.session);
  if (!session || session.method !== "token") throw new Error("The server did not establish an access-token session.");
  clearToken();
  notifySessionChange(session);
  return session;
}

export async function signOut(): Promise<void> {
  await request("/api/auth/logout", { method: "POST", body: {} });
  clearToken();
  notifySessionChange(null);
}

export async function listPasskeys(): Promise<PasskeyList> {
  const data = await request<Partial<PasskeyList> | null>("/api/auth/passkeys");
  return {
    canManage: data?.canManage === true,
    passkeys: Array.isArray(data?.passkeys) ? data.passkeys : [],
  };
}

export async function enrolPasskey(label: string): Promise<Passkey> {
  const { options } = await request<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/auth/passkey/register/options",
    { method: "POST", body: {} }
  );
  const response = await ceremony(() => startRegistration({ optionsJSON: options }));
  const data = await request<{ passkey: Passkey }>("/api/auth/passkey/register/verify", {
    method: "POST",
    body: { response, label: label.trim().slice(0, 64) },
  });
  return data.passkey;
}

export async function revokePasskey(id: string): Promise<void> {
  await request(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
