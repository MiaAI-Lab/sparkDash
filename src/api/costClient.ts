/**
 * Local-only API client for the cost-compare feature.
 * Mirrors llmTokenClient.ts: apiFetch is a small local copy so importing this
 * never pulls the rest of client.ts into a lazy chunk.
 */
import type { ModelPricesResponse } from "./costTypes";
import { authHeaders, reportAuthRequired } from "./authToken";

export function fetchModelPrices(): Promise<ModelPricesResponse> {
  return apiFetch("/api/model-prices");
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
