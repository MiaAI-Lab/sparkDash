import { fetchLaunchers } from "../api/client";
import type { LauncherListResponse, LauncherRunState } from "../api/types";

/** How long a fetched list (with its run statuses) is reused before the Spark is asked again. */
export const LAUNCHER_STALE_MS = 10_000;

interface Entry {
  data: LauncherListResponse;
  at: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<LauncherListResponse>>();

type Statuses = Record<string, LauncherRunState>;

/**
 * Run statuses come from an SSH probe. When that fails every launcher reports "unknown";
 * keep the last known statuses then, so a model that is loading does not look idle.
 */
export function mergeStatuses(prev: Statuses | undefined, next: Statuses | undefined): Statuses | undefined {
  if (!next) return prev;
  const values = Object.values(next);
  const allUnknown = values.length > 0 && values.every((v) => v === "unknown");
  if (!allUnknown || !prev) return next;
  const merged: Statuses = {};
  for (const id of Object.keys(next)) merged[id] = prev[id] ?? "unknown";
  return merged;
}

/** The last list fetched for a Spark, however old, or null. */
export function getCachedLaunchers(sparkId: string): LauncherListResponse | null {
  return entries.get(sparkId)?.data ?? null;
}

/** Overwrite one launcher's cached status (after Start, before the next probe confirms it). */
export function patchCachedStatus(sparkId: string, launcherId: string, status: LauncherRunState): void {
  const e = entries.get(sparkId);
  if (!e) return;
  e.data = { ...e.data, statuses: { ...(e.data.statuses ?? {}), [launcherId]: status } };
}

/** Make the next `fetchLaunchersCached` go to the Spark. */
export function invalidateLaunchers(sparkId: string): void {
  const e = entries.get(sparkId);
  if (e) e.at = 0;
}

/**
 * The launcher list with statuses for a Spark, shared by every card and panel. A result younger
 * than `maxAgeMs` is reused, and concurrent callers share one request (the SSH probe is slow).
 * `force` skips the staleness check but still joins a request already in flight.
 */
export function fetchLaunchersCached(
  sparkId: string,
  opts: { force?: boolean; maxAgeMs?: number; now?: () => number } = {}
): Promise<LauncherListResponse> {
  const { force = false, maxAgeMs = LAUNCHER_STALE_MS, now = Date.now } = opts;
  const cached = entries.get(sparkId);
  if (!force && cached && now() - cached.at < maxAgeMs) return Promise.resolve(cached.data);
  const pending = inflight.get(sparkId);
  if (pending) return pending;
  const request = fetchLaunchers(sparkId, true)
    .then((res) => {
      const data: LauncherListResponse = {
        ...res,
        statuses: mergeStatuses(entries.get(sparkId)?.data.statuses, res.statuses),
      };
      entries.set(sparkId, { data, at: now() });
      return data;
    })
    .finally(() => {
      inflight.delete(sparkId);
    });
  inflight.set(sparkId, request);
  return request;
}

/** Test helper. */
export function _resetLauncherCache(): void {
  entries.clear();
  inflight.clear();
}
