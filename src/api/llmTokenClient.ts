/**
 * Local-only API client for the llm-token-totals feature.
 * Sits outside src/api/client.ts so upstream merges never touch it.
 * apiFetch is a small local copy: client.ts does not export it, and importing
 * client.ts would pull its other handlers into any lazy chunk.
 */
import type { LlmTokenRange, LlmTokenTotalsResponse } from "./llmTokenTypes";
import { authHeaders, reportAuthRequired } from "./authToken";
import type { LocalizedMessage } from "./types";

export type LocalizedTokenApiError = Error & { status?: number; i18n?: Partial<Record<"error", LocalizedMessage>> };

export function fetchLlmTokenTotals(range?: LlmTokenRange): Promise<LlmTokenTotalsResponse> {
  return apiFetch(range && range !== "all" ? `/api/llm-token-totals?range=${range}` : "/api/llm-token-totals");
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`) as LocalizedTokenApiError;
    if (body.i18n && typeof body.i18n === "object") error.i18n = body.i18n as LocalizedTokenApiError["i18n"];
    error.status = res.status;
    throw error;
  }
  return res.json();
}
