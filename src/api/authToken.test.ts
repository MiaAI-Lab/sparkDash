import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  clearToken,
  fetchAuthStatus,
  getToken,
  onAuthRequired,
  onTokenChange,
  reportAuthRequired,
  requestTokenPrompt,
  setToken,
} from "./authToken";

describe("authToken storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("sparkdashToken");
    vi.unstubAllGlobals();
  });

  it("reads, writes and clears the same sparkdashToken key the UI always used", () => {
    expect(getToken()).toBe("");
    localStorage.setItem("sparkdashToken", "from-devtools");
    expect(getToken()).toBe("from-devtools");

    setToken("  s3cret \n");
    expect(localStorage.getItem("sparkdashToken")).toBe("s3cret");
    expect(getToken()).toBe("s3cret");

    clearToken();
    expect(localStorage.getItem("sparkdashToken")).toBeNull();
    expect(getToken()).toBe("");
  });

  it("treats saving an empty token as clearing it", () => {
    setToken("s3cret");
    setToken("   ");
    expect(localStorage.getItem("sparkdashToken")).toBeNull();
  });

  it("builds the bearer header from the live token, or none without one", () => {
    expect(authHeaders()).toEqual({});
    setToken("abc");
    expect(authHeaders()).toEqual({ Authorization: "Bearer abc" });
    expect(authHeaders("other")).toEqual({ Authorization: "Bearer other" });
  });

  it("notifies token listeners on a real change only", () => {
    const seen: string[] = [];
    const off = onTokenChange((t) => seen.push(t));
    setToken("one");
    setToken("one");
    setToken("two");
    clearToken();
    clearToken();
    off();
    setToken("three");
    expect(seen).toEqual(["one", "two", ""]);
  });

  it("survives storage that throws (private mode, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(getToken()).toBe("");
    expect(() => setToken("x")).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });
});

describe("authToken signals and status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("sparkdashToken");
    vi.unstubAllGlobals();
  });

  it("tells subscribers why the prompt is wanted", () => {
    const reasons: string[] = [];
    const off = onAuthRequired((r) => reasons.push(r));
    reportAuthRequired();
    requestTokenPrompt();
    off();
    reportAuthRequired();
    expect(reasons).toEqual(["rejected", "manual"]);
  });

  it("asks /api/auth/status with the candidate token instead of the stored one", async () => {
    setToken("stored");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ tokenRequired: true, authenticated: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuthStatus("candidate")).resolves.toEqual({ tokenRequired: true, authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/status", {
      headers: { Authorization: "Bearer candidate" },
    });

    await fetchAuthStatus();
    expect((fetchMock.mock.calls[1] as unknown[])[1]).toEqual({ headers: { Authorization: "Bearer stored" } });
  });
});
