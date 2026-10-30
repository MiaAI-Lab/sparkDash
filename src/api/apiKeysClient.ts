/**
 * Local-only API client for the opt-in, read-only API Keys page.
 * Mirrors costClient.ts: a small local apiFetch so importing this never pulls in client.ts.
 */
import { authHeaders, reportAuthRequired } from "./authToken";

/** One LiteLLM virtual key as the bridge reports it. null = not reported (render as unknown, never 0). */
export interface ApiKeyRecord {
  id: string;
  alias: string | null;
  state: "active" | "blocked" | "expired" | "unknown";
  blocked: boolean | null;
  spend: number | null;
  maxBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  expires: string | null;
  createdAt: string | null;
  lastActive: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxParallelRequests: number | null;
  models: string[];
}

export interface ApiKeysStatus {
  configured: boolean;
  bridge: "ok" | "down" | "unconfigured";
  upstream: "ok" | "down" | "unknown";
  bridgeVersion?: string | null;
  error: string | null;
  retryAfterSec: number | null;
}

export function fetchApiKeysStatus(): Promise<ApiKeysStatus> {
  return apiFetch("/api/apikeys/status");
}

export function fetchApiKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiFetch("/api/apikeys/keys");
}

export function fetchApiKey(id: string): Promise<{ key: ApiKeyRecord }> {
  return apiFetch(`/api/apikeys/keys/${encodeURIComponent(id)}`);
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { ...authHeaders() } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
