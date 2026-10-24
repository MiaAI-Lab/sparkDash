import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { getToken, onSessionChange, onTokenChange, setToken, type AuthSession } from "./authToken";
import {
  enrolPasskey,
  isPasskeyCancelled,
  listPasskeys,
  PasskeyRequestError,
  revokePasskey,
  signInWithPasskey,
  signInWithToken,
  signOut,
} from "./passkeys";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Routes "METHOD /path" to a response; records every call. */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        url,
        method,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const route = routes[`${method} ${url}`];
      return route ? route() : json({ error: "not found" }, 404);
    })
  );
  return calls;
}

function recordSessions() {
  const seen: Array<AuthSession | null> = [];
  const off = onSessionChange((s) => seen.push(s));
  return { seen, off };
}

const notAllowed = () => Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

describe("passkey client", () => {
  beforeEach(() => {
    vi.mocked(startAuthentication).mockReset();
    vi.mocked(startRegistration).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashToken");
  });

  it("exchanges the token for a session without storing it, and clears a stored copy", async () => {
    setToken("old");
    const calls = stubFetch({
      "POST /api/auth/session/token": () => json({ ok: true, session: { method: "token", canManage: true } }),
    });
    const sessions = recordSessions();
    const tokens: string[] = [];
    const offToken = onTokenChange((t) => tokens.push(t));

    await expect(signInWithToken("  s3cret ")).resolves.toEqual({ method: "token", canManage: true });

    expect(calls).toEqual([
      {
        url: "/api/auth/session/token",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
        body: {},
      },
    ]);
    expect(getToken()).toBe("");
    expect(localStorage.getItem("sparkdashToken")).toBeNull();
    expect(tokens).toEqual([""]);
    expect(sessions.seen).toEqual([{ method: "token", canManage: true }]);
    sessions.off();
    offToken();
  });

  it.each(["token", "passkey"])("does not invent a %s session when the server returns no session", async (method) => {
    setToken("existing-token");
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    stubFetch({
      "POST /api/auth/session/token": () => json({}),
      "POST /api/auth/passkey/login/options": () => json({ options: { challenge: "c" } }),
      "POST /api/auth/passkey/login/verify": () => json({}),
    });
    const sessions = recordSessions();
    try {
      const signIn = method === "token" ? signInWithToken("candidate") : signInWithPasskey();
      await expect(signIn).rejects.toThrow(/session/);
      expect(getToken()).toBe("existing-token");
      expect(sessions.seen).toEqual([]);
    } finally {
      sessions.off();
    }
  });

  it("surfaces the server's error text and emits no session when the token is refused", async () => {
    stubFetch({
      "POST /api/auth/session/token": () => json({ error: "This server accepts passkeys only." }, 403),
    });
    const sessions = recordSessions();
    const err = await signInWithToken("s3cret").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyRequestError);
    expect(err).toMatchObject({ status: 403, message: "This server accepts passkeys only." });
    expect(sessions.seen).toEqual([]);
    sessions.off();
  });

  it("signs in with a passkey: options, ceremony, verify, then the session signal", async () => {
    const options = { challenge: "abc", allowCredentials: [] };
    const assertion = { id: "cred", rawId: "cred", type: "public-key", response: {} };
    vi.mocked(startAuthentication).mockResolvedValue(assertion as never);
    const calls = stubFetch({
      "POST /api/auth/passkey/login/options": () => json({ options }),
      "POST /api/auth/passkey/login/verify": () => json({ ok: true, session: { method: "passkey", canManage: false } }),
    });
    const sessions = recordSessions();

    await expect(signInWithPasskey()).resolves.toEqual({ method: "passkey", canManage: false });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/api/auth/passkey/login/options", {}],
      ["POST", "/api/auth/passkey/login/verify", { response: assertion }],
    ]);
    expect(sessions.seen).toEqual([{ method: "passkey", canManage: false }]);
    sessions.off();
  });

  it("clears a saved bearer before passkey-session listeners make management requests", async () => {
    setToken("valid-token");
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    const calls = stubFetch({
      "POST /api/auth/passkey/login/options": () => json({ options: { challenge: "c" } }),
      "POST /api/auth/passkey/login/verify": () => json({ session: { method: "passkey", canManage: false } }),
      "GET /api/auth/passkeys": () => json({ canManage: false, passkeys: [] }),
    });
    const tokensAtSessionChange: string[] = [];
    let managementRequest: Promise<unknown> | undefined;
    const off = onSessionChange(() => {
      tokensAtSessionChange.push(getToken());
      managementRequest = listPasskeys();
    });
    try {
      await signInWithPasskey();
      await managementRequest;
      expect(localStorage.getItem("sparkdashToken")).toBeNull();
      expect(tokensAtSessionChange).toEqual([""]);
      expect(calls.at(-1)).toMatchObject({ url: "/api/auth/passkeys", headers: {} });
    } finally {
      off();
    }
  });

  it("keeps the saved bearer and session unchanged when passkey verification fails", async () => {
    setToken("valid-token");
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    stubFetch({
      "POST /api/auth/passkey/login/options": () => json({ options: { challenge: "c" } }),
      "POST /api/auth/passkey/login/verify": () => json({ error: "Invalid passkey" }, 401),
    });
    const sessions = recordSessions();
    try {
      await expect(signInWithPasskey()).rejects.toThrow("Invalid passkey");
      expect(getToken()).toBe("valid-token");
      expect(sessions.seen).toEqual([]);
    } finally {
      sessions.off();
    }
  });

  it("turns a cancelled or timed-out passkey prompt into a quiet, distinct error", async () => {
    vi.mocked(startAuthentication).mockRejectedValue(notAllowed());
    const calls = stubFetch({ "POST /api/auth/passkey/login/options": () => json({ options: { challenge: "x" } }) });
    const err = await signInWithPasskey().catch((e: unknown) => e);
    expect(isPasskeyCancelled(err)).toBe(true);
    expect(err).not.toBeInstanceOf(PasskeyRequestError);
    expect(calls).toHaveLength(1);
  });

  it("sends the stored token with management calls and the trimmed label on enrol", async () => {
    setToken("tok");
    const passkey = { id: "p1", label: "Laptop", createdAt: "2026-10-01T10:00:00.000Z", lastUsedAt: null };
    const attestation = { id: "cred", rawId: "cred", type: "public-key", response: {} };
    vi.mocked(startRegistration).mockResolvedValue(attestation as never);
    const calls = stubFetch({
      "GET /api/auth/passkeys": () => json({ canManage: true, passkeys: [passkey] }),
      "POST /api/auth/passkey/register/options": () => json({ options: { challenge: "c" } }),
      "POST /api/auth/passkey/register/verify": () => json({ ok: true, passkey }),
      "DELETE /api/auth/passkeys/p%2F1": () => json({ ok: true }),
    });

    await expect(listPasskeys()).resolves.toEqual({ canManage: true, passkeys: [passkey] });
    await expect(enrolPasskey("  Laptop  ")).resolves.toEqual(passkey);
    await revokePasskey("p/1");

    expect(calls.every((c) => c.headers.Authorization === "Bearer tok")).toBe(true);
    expect(calls.find((c) => c.url === "/api/auth/passkey/register/verify")?.body).toEqual({
      response: attestation,
      label: "Laptop",
    });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "/api/auth/passkeys/p%2F1" });
  });

  it("reports a refused enrolment with the server's text", async () => {
    stubFetch({
      "POST /api/auth/passkey/register/options": () => json({ error: "Enrolling a passkey needs the access token." }, 403),
    });
    await expect(enrolPasskey("")).rejects.toThrow("Enrolling a passkey needs the access token.");
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("clears a saved bearer on logout before listeners refresh authentication", async () => {
    setToken("valid-token");
    const calls = stubFetch({
      "POST /api/auth/logout": () => json({ ok: true }),
      "GET /api/auth/passkeys": () => json({ error: "Authentication required" }, 401),
    });
    const sessions = recordSessions();
    const tokensAtSessionChange: string[] = [];
    const off = onSessionChange(() => tokensAtSessionChange.push(getToken()));
    try {
      await signOut();
      expect(calls[0]).toMatchObject({ method: "POST", url: "/api/auth/logout" });
      expect(localStorage.getItem("sparkdashToken")).toBeNull();
      expect(tokensAtSessionChange).toEqual([""]);
      expect(sessions.seen).toEqual([null]);
      await expect(listPasskeys()).rejects.toThrow("Authentication required");
      expect(calls.at(-1)).toMatchObject({ url: "/api/auth/passkeys", headers: {} });
    } finally {
      off();
      sessions.off();
    }
  });

  it("keeps the saved bearer and session unchanged when logout fails", async () => {
    setToken("valid-token");
    stubFetch({ "POST /api/auth/logout": () => json({ error: "Logout failed" }, 500) });
    const sessions = recordSessions();
    try {
      await expect(signOut()).rejects.toThrow("Logout failed");
      expect(getToken()).toBe("valid-token");
      expect(sessions.seen).toEqual([]);
    } finally {
      sessions.off();
    }
  });
});
