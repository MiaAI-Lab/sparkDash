import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLaunchers = vi.fn();
vi.mock("../api/client", () => ({ fetchLaunchers: (...a: unknown[]) => fetchLaunchers(...a) }));

import {
  LAUNCHER_STALE_MS,
  _resetLauncherCache,
  fetchLaunchersCached,
  getCachedLaunchers,
  invalidateLaunchers,
  mergeStatuses,
  patchCachedStatus,
} from "./launcherCache";

const launcher = (id: string) => ({ id, name: id, dir: "/m", startScript: "start.sh", stopScript: "stop.sh", port: null, notes: "" });
const res = (statuses: Record<string, string>) => ({ launchers: [launcher("a"), launcher("b")], job: null, statuses });

describe("mergeStatuses", () => {
  it("keeps known statuses when the probe answered unknown for everything", () => {
    expect(mergeStatuses({ a: "running", b: "stopped" }, { a: "unknown", b: "unknown" })).toEqual({ a: "running", b: "stopped" });
  });
  it("takes a real answer, including a partly unknown one", () => {
    expect(mergeStatuses({ a: "running" }, { a: "stopped", b: "unknown" })).toEqual({ a: "stopped", b: "unknown" });
  });
  it("does not invent statuses for launchers it never saw", () => {
    expect(mergeStatuses({ a: "running" }, { a: "unknown", c: "unknown" })).toEqual({ a: "running", c: "unknown" });
    expect(mergeStatuses(undefined, { a: "unknown" })).toEqual({ a: "unknown" });
  });
});

describe("fetchLaunchersCached", () => {
  beforeEach(() => {
    _resetLauncherCache();
    fetchLaunchers.mockReset();
  });

  it("shares one request between concurrent callers", async () => {
    fetchLaunchers.mockResolvedValue(res({ a: "running", b: "stopped" }));
    const [x, y] = await Promise.all([fetchLaunchersCached("s1"), fetchLaunchersCached("s1")]);
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
  });

  it("reuses a result inside the staleness window and refetches after it", async () => {
    fetchLaunchers.mockResolvedValue(res({ a: "stopped", b: "stopped" }));
    let t = 1000;
    const now = () => t;
    await fetchLaunchersCached("s1", { now });
    t += LAUNCHER_STALE_MS - 1;
    await fetchLaunchersCached("s1", { now });
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);
    t += 2;
    await fetchLaunchersCached("s1", { now });
    expect(fetchLaunchers).toHaveBeenCalledTimes(2);
  });

  it("force and invalidate bypass the window", async () => {
    fetchLaunchers.mockResolvedValue(res({ a: "stopped", b: "stopped" }));
    await fetchLaunchersCached("s1");
    await fetchLaunchersCached("s1", { force: true });
    invalidateLaunchers("s1");
    await fetchLaunchersCached("s1");
    expect(fetchLaunchers).toHaveBeenCalledTimes(3);
  });

  it("keeps the previous statuses when a later probe is all unknown", async () => {
    fetchLaunchers.mockResolvedValueOnce(res({ a: "running", b: "stopped" }));
    await fetchLaunchersCached("s1");
    fetchLaunchers.mockResolvedValueOnce(res({ a: "unknown", b: "unknown" }));
    const next = await fetchLaunchersCached("s1", { force: true });
    expect(next.statuses).toEqual({ a: "running", b: "stopped" });
    expect(getCachedLaunchers("s1")?.statuses).toEqual({ a: "running", b: "stopped" });
  });

  it("keeps the old data when a request fails and lets the next call retry", async () => {
    fetchLaunchers.mockResolvedValueOnce(res({ a: "stopped", b: "stopped" }));
    await fetchLaunchersCached("s1");
    fetchLaunchers.mockRejectedValueOnce(new Error("boom"));
    await expect(fetchLaunchersCached("s1", { force: true })).rejects.toThrow("boom");
    expect(getCachedLaunchers("s1")).not.toBeNull();
    fetchLaunchers.mockResolvedValueOnce(res({ a: "running", b: "stopped" }));
    expect((await fetchLaunchersCached("s1", { force: true })).statuses?.a).toBe("running");
  });

  it("patches a status in the cache and keeps Sparks apart", async () => {
    fetchLaunchers.mockResolvedValue(res({ a: "stopped", b: "stopped" }));
    await fetchLaunchersCached("s1");
    patchCachedStatus("s1", "a", "running");
    expect(getCachedLaunchers("s1")?.statuses?.a).toBe("running");
    expect(getCachedLaunchers("s2")).toBeNull();
  });
});
