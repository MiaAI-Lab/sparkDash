/**
 * The browser's copy of the server's access token (SPARKDASH_TOKEN).
 *
 * Every caller reads it live through getToken()/authHeaders(), so saving a new
 * token takes effect on the next request without a reload. Storage can throw
 * (private mode, blocked site data); a failed read is treated as "no token".
 *
 * Two signals let the app react without the API layer knowing about React:
 * - onTokenChange: the stored token changed (useSnapshot reconnects the WebSocket)
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

function emit<T>(listeners: Set<Listener<T>>, value: T) {
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

/** Called by the API layer on a 401 (or a WebSocket refused for the token). */
export function reportAuthRequired(): void {
  emit(authRequiredListeners, "rejected");
}

/** Open the token dialog on purpose (Settings → Change). */
export function requestTokenPrompt(): void {
  emit(authRequiredListeners, "manual");
}

// ─── Server status ────────────────────────────────────────

export interface AuthStatus {
  /** A token is configured and gates the WebSocket and mutations. */
  tokenRequired: boolean;
  /** The credentials sent with this request would pass. */
  authenticated: boolean;
}

/**
 * Ask the server whether a token is needed and whether `token` (default: the
 * stored one) satisfies it. Served ahead of the auth middleware, so it answers
 * even when the token is missing or wrong.
 */
export async function fetchAuthStatus(token: string = getToken()): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status", { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Partial<AuthStatus>;
  return { tokenRequired: Boolean(body.tokenRequired), authenticated: Boolean(body.authenticated) };
}
