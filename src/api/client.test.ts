import { afterEach, describe, expect, it, vi } from "vitest";

// client.ts reads the token when the module loads, so each case stores (or
// clears) it first and imports a fresh copy of the module.
async function loadClient() {
  vi.resetModules();
  return import("./client");
}

describe("fetchInferenceActivity", () => {
  afterEach(() => { localStorage.removeItem("sparkdashToken"); vi.unstubAllGlobals(); });
  it("uses the ordinary authenticated dashboard GET without sending an inference key", async () => {
    localStorage.setItem("sparkdashToken", "dashboard-token");
    const payload = { enabled: false, available: false, labels: [], active: [], recent: [] };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchInferenceActivity } = await loadClient();
    expect(await fetchInferenceActivity()).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/inference/activity", { headers: { Authorization: "Bearer dashboard-token" } });
  });
});

describe("cancelShowcaseBeacon", () => {
  afterEach(() => {
    localStorage.removeItem("sparkdashToken");
    vi.unstubAllGlobals();
  });

  it("sends the stored access token with the keepalive DELETE", async () => {
    localStorage.setItem("sparkdashToken", "s3cret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { cancelShowcaseBeacon } = await loadClient();

    cancelShowcaseBeacon("spark 1", "sess/42");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sparks/spark%201/llm/showcase/sess%2F42");
    expect(init).toMatchObject({ method: "DELETE", keepalive: true });
    expect(init.headers).toEqual({ Authorization: "Bearer s3cret" });
  });

  it("sends no Authorization header when no token is stored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { cancelShowcaseBeacon } = await loadClient();

    cancelShowcaseBeacon("spark-1", "abc");

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "DELETE", keepalive: true });
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("swallows a rejected request so unload handlers never throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { cancelShowcaseBeacon } = await loadClient();

    expect(() => cancelShowcaseBeacon("spark-1", "abc")).not.toThrow();
    await Promise.resolve();
  });
});

describe("Mac runtime control transport", () => {
  afterEach(() => { localStorage.removeItem("sparkdashToken"); vi.unstubAllGlobals(); });

  it("marks a lost submission response as unresolved without replaying", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const { stopMacRuntime } = await loadClient();
    expect(await stopMacRuntime("mac", "splash-thinkingcap")).toMatchObject({ state: "unavailable", transportError: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an accepted operation and treats an unreadable response as unresolved", async () => {
    const operation = { id: "accepted-id", state: "running", action: "start", runtime: "splash-thinkingcap" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ state: "ready", busy: true, operation, serving: [], targets: [] }, { status: 202 }))
      .mockResolvedValueOnce(new Response("truncated", { status: 202 }))
      .mockResolvedValueOnce(Response.json({}, { status: 202 })));
    const { startMacRuntime } = await loadClient();
    expect(await startMacRuntime("mac", "splash-thinkingcap")).toMatchObject({ state: "ready", busy: true, operation });
    expect(await startMacRuntime("mac", "splash-thinkingcap")).toMatchObject({ state: "unavailable", transportError: true });
    expect(await startMacRuntime("mac", "splash-thinkingcap")).toMatchObject({ state: "unavailable", transportError: true });
  });

  it("keeps a definite refusal distinct from a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ state: "denied", reason: "permission denied" }, { status: 403 })));
    const { startMacRuntime } = await loadClient();
    const result = await startMacRuntime("mac", "splash-thinkingcap");
    expect(result.state).toBe("denied");
    expect(result.transportError).not.toBe(true);
  });
});
