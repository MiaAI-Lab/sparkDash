import { afterEach, describe, expect, it, vi } from "vitest";

// client.ts reads the token when the module loads, so each case stores (or
// clears) it first and imports a fresh copy of the module.
async function loadClient() {
  vi.resetModules();
  return import("./client");
}

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
