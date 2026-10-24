import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { AccessTokenPrompt } from "./AccessTokenDialog";
import { fetchSparks } from "../api/client";
import { getToken, onSessionChange, requestTokenPrompt, type AuthSession } from "../api/authToken";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Server stub: every API call needs `accepted`; /api/auth/status answers for any token. */
function stubServer(accepted: string) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const ok = auth === `Bearer ${accepted}`;
    if (url === "/api/auth/status") return json({ tokenRequired: true, authenticated: ok });
    return ok ? json({ sparks: [] }) : json({ error: "Authentication required" }, 401);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string) {
  return Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

async function settle() {
  await flush();
  await flush();
}

describe("AccessTokenPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    cleanupRenders();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashToken");
  });

  it("opens on a 401 and saving stores the token the server accepts", async () => {
    const fetchMock = stubServer("s3cret");
    render(<AccessTokenPrompt />);
    expect(dialog()).toBeNull();

    await expect(fetchSparks()).rejects.toThrow("Authentication required");
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Access token");

    const input = dialog()!.querySelector<HTMLInputElement>("input")!;
    expect(input.type).toBe("password");
    typeInto(input, "  s3cret ");
    act(() => button("Save").click());
    await settle();

    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/status", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(getToken()).toBe("s3cret");
    act(() => vi.advanceTimersByTime(300));
    expect(dialog()).toBeNull();

    // The next request carries the saved token and succeeds.
    await expect(fetchSparks()).resolves.toEqual({ sparks: [] });
  });

  it("keeps the dialog open with an error when the server rejects the token", async () => {
    stubServer("s3cret");
    render(<AccessTokenPrompt />);
    await expect(fetchSparks()).rejects.toThrow();
    await settle();

    typeInto(dialog()!.querySelector<HTMLInputElement>("input")!, "wrong");
    act(() => button("Save").click());
    await settle();

    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toMatch(/rejected this token/);
    expect(getToken()).toBe("");
  });

  it("says the saved token was rejected when it reopens with one stored", async () => {
    localStorage.setItem("sparkdashToken", "stale");
    stubServer("s3cret");
    render(<AccessTokenPrompt />);
    await expect(fetchSparks()).rejects.toThrow();
    await settle();

    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toMatch(/saved token was rejected/);
  });

  it("stays closed after Cancel until the token changes or Settings asks", async () => {
    stubServer("s3cret");
    render(<AccessTokenPrompt />);
    await expect(fetchSparks()).rejects.toThrow();
    await settle();
    act(() => button("Cancel").click());
    act(() => vi.advanceTimersByTime(300));
    expect(dialog()).toBeNull();

    await expect(fetchSparks()).rejects.toThrow();
    await settle();
    expect(dialog()).toBeNull();

    act(() => requestTokenPrompt());
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
  });
});

/** A host with passkeys armed: the token is exchanged for a session, never checked via status. */
function stubPasskeyServer(accepted: string, tokenRefusal?: { status: number; error: string }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    if (url === "/api/auth/status") {
      return json({ tokenRequired: true, authenticated: false, passkeys: { enabled: true, passkeyOnly: false }, session: null });
    }
    if (url === "/api/auth/session/token") {
      if (tokenRefusal) return json({ error: tokenRefusal.error }, tokenRefusal.status);
      return auth === `Bearer ${accepted}`
        ? json({ ok: true, session: { method: "token", canManage: true } })
        : json({ error: "Invalid access token" }, 401);
    }
    if (url === "/api/auth/passkey/login/options") return json({ options: { challenge: "c" } });
    if (url === "/api/auth/passkey/login/verify") return json({ ok: true, session: { method: "passkey", canManage: false } });
    return json({ error: "Authentication required" }, 401);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function textButton(label: string) {
  return Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent === label);
}

describe("AccessTokenPrompt with passkeys armed", () => {
  let sessions: Array<AuthSession | null>;
  let offSession: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
    vi.mocked(startAuthentication).mockReset();
    sessions = [];
    offSession = onSessionChange((s) => sessions.push(s));
  });

  afterEach(() => {
    offSession();
    cleanupRenders();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashToken");
  });

  async function openPrompt() {
    render(<AccessTokenPrompt />);
    act(() => requestTokenPrompt());
    await settle();
  }

  it("becomes a Sign in dialog with a passkey button", async () => {
    stubPasskeyServer("s3cret");
    await openPrompt();
    expect(dialog()!.querySelector(".modal-sheet__header")?.textContent).toBe("Sign in");
    expect(textButton("Sign in with a passkey")).toBeDefined();
    expect(dialog()!.textContent).toContain("Sign in with the access token");
    expect(textButton("Save")).toBeUndefined();
  });

  it("signs in with a passkey, clears the saved bearer, and closes", async () => {
    localStorage.setItem("sparkdashToken", "s3cret");
    stubPasskeyServer("s3cret");
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred" } as never);
    await openPrompt();
    act(() => textButton("Sign in with a passkey")!.click());
    await settle();
    expect(sessions).toEqual([{ method: "passkey", canManage: false }]);
    expect(getToken()).toBe("");
    expect(localStorage.getItem("sparkdashToken")).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(dialog()).toBeNull();
  });

  it("says quietly that a cancelled passkey prompt was cancelled", async () => {
    stubPasskeyServer("s3cret");
    vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await openPrompt();
    act(() => textButton("Sign in with a passkey")!.click());
    await settle();
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toMatch(/cancelled or timed out/);
    expect(sessions).toEqual([]);
  });

  it("explains instead of offering a passkey when the browser cannot use one", async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    stubPasskeyServer("s3cret");
    await openPrompt();
    expect(textButton("Sign in with a passkey")).toBeUndefined();
    expect(dialog()!.querySelector('[data-testid="passkey-unsupported"]')?.textContent).toMatch(/cannot use a passkey/);
  });

  it("exchanges the token for a session and does not store it", async () => {
    localStorage.setItem("sparkdashToken", "stale");
    const fetchMock = stubPasskeyServer("s3cret");
    await openPrompt();
    typeInto(dialog()!.querySelector<HTMLInputElement>("input")!, " s3cret ");
    act(() => textButton("Sign in with token")!.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session/token",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer s3cret" }) })
    );
    expect(getToken()).toBe("");
    expect(localStorage.getItem("sparkdashToken")).toBeNull();
    expect(sessions).toEqual([{ method: "token", canManage: true }]);
    act(() => vi.advanceTimersByTime(300));
    expect(dialog()).toBeNull();
  });

  it("offers legacy token login if the authority store becomes unavailable while this dialog is open", async () => {
    let enabled = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/session/token") {
        enabled = false;
        return json({ error: "Could not save passkey state" }, 500);
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return json({ tokenRequired: true, authenticated: auth === "Bearer s3cret", passkeys: { enabled }, session: null });
    }));
    await openPrompt();
    typeInto(dialog()!.querySelector<HTMLInputElement>("input")!, "s3cret");
    act(() => textButton("Sign in with token")!.click());
    await settle();
    expect(getToken()).toBe("");
    expect(textButton("Save")).toBeDefined();
    act(() => textButton("Save")!.click());
    await settle();
    expect(getToken()).toBe("s3cret");
    expect(sessions).toEqual([]);
  });

  it.each([
    [401, "Invalid access token"],
    [403, "The access token is refused once a passkey is enrolled."],
  ])("shows the server's error on %i and keeps the dialog open", async (status, error) => {
    stubPasskeyServer("s3cret", { status, error });
    await openPrompt();
    typeInto(dialog()!.querySelector<HTMLInputElement>("input")!, "s3cret");
    act(() => textButton("Sign in with token")!.click());
    await settle();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe(error);
    expect(getToken()).toBe("");
    expect(sessions).toEqual([]);
  });
});
