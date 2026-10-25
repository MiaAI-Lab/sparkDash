/**
 * Client for the fork's ten-second LLM telemetry store.
 * Sits outside src/api/client.ts (like llmTokenClient) so upstream merges never
 * touch it, and so components that read it do not break tests that mock client.ts.
 */
import type { LlmTelemetryResponse } from "./types";
import { authHeaders, reportAuthRequired } from "./authToken";

/** Restart-safe ten-second LLM telemetry for incident and capacity analysis. */
export function fetchLlmTelemetry(id: string, port: number, hours = 24): Promise<LlmTelemetryResponse> {
  const q = new URLSearchParams({ port: String(port), hours: String(hours) });
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/llm/telemetry?${q.toString()}`);
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
