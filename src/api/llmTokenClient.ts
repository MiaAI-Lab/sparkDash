/**
 * Local-only API client for the llm-token-totals feature.
 * Sits outside src/api/client.ts so upstream merges never touch it.
 * apiFetch/authHeaders are small local copies: client.ts does not export them,
 * and importing client.ts would pull its other handlers into any lazy chunk.
 */
import type { LlmTokenRange, LlmTokenTotalsResponse } from "./llmTokenTypes";

const TOKEN =
  (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

export function fetchLlmTokenTotals(range?: LlmTokenRange): Promise<LlmTokenTotalsResponse> {
  return apiFetch(range && range !== "all" ? `/api/llm-token-totals?range=${range}` : "/api/llm-token-totals");
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
