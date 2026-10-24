/**
 * The browser's copy of the server's access token (SPARKDASH_TOKEN).
 *
 * Every caller reads it live through getToken()/authHeaders(), so saving a new
 * token takes effect on the next request without a reload. Storage can throw
 * (private mode, blocked site data); a failed read is treated as "no token".
 *
 * Three signals let the app react without the API layer knowing about React:
 * - onTokenChange: the stored token changed (useSnapshot reconnects the WebSocket)
 * - onSessionChange: a passkey/token sign-in or a sign-out changed the session
 *   cookie (useSnapshot reconnects, App reloads settings), see ./passkeys
 * - onAuthRequired: the server rejected our credentials (App opens the token dialog)
 */

const STORAGE_KEY = "sparkdashToken";

export function getToken(): string {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  const next = token.trim();
  if (!next) {
    clearToken();
    return;
  }
  if (next === getToken()) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable — the token cannot persist */
  }
  emit(tokenListeners, next);
}

export function clearToken(): void {
  const had = getToken() !== "";
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (had) emit(tokenListeners, "");
}

export function authHeaders(token: string = getToken()): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Signals ──────────────────────────────────────────────

/** "rejected": the server refused the request; "manual": the user asked to change it. */
export type AuthPromptReason = "rejected" | "manual";

type Listener<T> = (value: T) => void;
const tokenListeners = new Set<Listener<string>>();
const authRequiredListeners = new Set<Listener<AuthPromptReason>>();
const sessionListeners = new Set<Listener<AuthSession | null>>();

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) listener(value);
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onTokenChange(listener: Listener<string>): () => void {
  return subscribe(tokenListeners, listener);
}

export function onAuthRequired(listener: Listener<AuthPromptReason>): () => void {
  return subscribe(authRequiredListeners, listener);
}

/** The session cookie changed: signed in (with how), or signed out (null). */
export function onSessionChange(listener: Listener<AuthSession | null>): () => void {
  return subscribe(sessionListeners, listener);
}

export function notifySessionChange(session: AuthSession | null): void {
  emit(sessionListeners, session);
}

/** Called by the API layer on a 401 (or a WebSocket refused for the token). */
export function reportAuthRequired(): void {
  emit(authRequiredListeners, "rejected");
}

/** Open the token dialog on purpose (Settings → Change). */
export function requestTokenPrompt(): void {
  emit(authRequiredListeners, "manual");
}

// ─── Server status ────────────────────────────────────────

export type PasskeyStatus = { enabled: false } | { enabled: true; passkeyOnly: boolean };

/** A browser session (HttpOnly cookie) and how it was established. */
export interface AuthSession {
  method: "passkey" | "token";
  /** May enrol and revoke passkeys: only a session established by the token. */
  canManage: boolean;
}

export interface AuthStatus {
  /** A token is configured and gates the WebSocket and mutations. */
  tokenRequired: boolean;
  /** The credentials sent with this request would pass. */
  authenticated: boolean;
  /** Passkey sign-in is armed on the host. An older server omits it: disabled. */
  passkeys: PasskeyStatus;
  /** The session cookie this request carried, if any. */
  session: AuthSession | null;
}

function parsePasskeyStatus(value: unknown): PasskeyStatus {
  const v = value as { enabled?: unknown; passkeyOnly?: unknown } | null | undefined;
  return v?.enabled === true ? { enabled: true, passkeyOnly: v.passkeyOnly === true } : { enabled: false };
}

export function parseSession(value: unknown): AuthSession | null {
  const v = value as { method?: unknown; canManage?: unknown } | null | undefined;
  if (v?.method !== "passkey" && v?.method !== "token") return null;
  return { method: v.method, canManage: v.canManage === true };
}

/**
 * Ask the server whether a token is needed and whether `token` (default: the
 * stored one) satisfies it. Served ahead of the auth middleware, so it answers
 * even when the token is missing or wrong. A session cookie, when present, is
 * sent too and counts towards `authenticated`.
 */
export async function fetchAuthStatus(token: string = getToken()): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status", { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Record<keyof AuthStatus, unknown>>;
  return {
    tokenRequired: Boolean(body.tokenRequired),
    authenticated: Boolean(body.authenticated),
    passkeys: parsePasskeyStatus(body.passkeys),
    session: parseSession(body.session),
  };
}
