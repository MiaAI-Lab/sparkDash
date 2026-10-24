import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { PasskeySettings } from "./PasskeySettings";
import { setLocale } from "../i18n";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LAPTOP = { id: "p1", label: "Laptop", createdAt: "2026-10-01T10:00:00.000Z", lastUsedAt: "2026-10-20T08:30:00.000Z" };
const PHONE = { id: "p2", label: "", createdAt: "2026-10-02T10:00:00.000Z", lastUsedAt: null };

interface ServerState {
  status: Record<string, unknown>;
  canManage: boolean;
  passkeys: Array<typeof LAPTOP | typeof PHONE>;
}

function stubServer(state: ServerState) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    if (url === "/api/auth/status") return json(state.status);
    if (method === "GET" && url === "/api/auth/passkeys") {
      return json({ canManage: state.canManage, passkeys: state.passkeys });
    }
    if (method === "POST" && url === "/api/auth/passkey/register/options") return json({ options: { challenge: "c" } });
    if (method === "POST" && url === "/api/auth/passkey/register/verify") {
      const { label } = JSON.parse(String(init.body)) as { label: string };
      const passkey = { id: "p3", label, createdAt: "2026-10-24T09:00:00.000Z", lastUsedAt: null };
      state.passkeys = [...state.passkeys, passkey];
      return json({ ok: true, passkey });
    }
    if (method === "DELETE" && url.startsWith("/api/auth/passkeys/")) {
      const id = decodeURIComponent(url.slice("/api/auth/passkeys/".length));
      state.passkeys = state.passkeys.filter((p) => p.id !== id);
      return json({ ok: true });
    }
    if (method === "POST" && url === "/api/auth/logout") {
      state.status = { ...state.status, session: null };
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ENABLED = { enabled: true, passkeyOnly: false };

async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

function buttons() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")];
}
const button = (text: string) => buttons().find((b) => b.textContent === text);

describe("Settings → Passkeys", () => {
  beforeEach(async () => {
    await setLocale("en");
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
    vi.mocked(startRegistration).mockReset();
  });
  afterEach(() => {
    cleanupRenders();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is absent when passkeys are off, or the server predates them", async () => {
    stubServer({ status: { tokenRequired: true, authenticated: true }, canManage: true, passkeys: [] });
    const { container } = render(<PasskeySettings />);
    await settle();
    expect(container.textContent).toBe("");

    cleanupRenders();
    stubServer({ status: { tokenRequired: true, authenticated: true, passkeys: { enabled: false }, session: null }, canManage: true, passkeys: [] });
    const second = render(<PasskeySettings />);
    await settle();
    expect(second.container.textContent).toBe("");
  });

  it("with token authority lists passkeys and offers add and revoke", async () => {
    const state: ServerState = {
      status: { tokenRequired: true, authenticated: true, passkeys: ENABLED, session: { method: "token", canManage: true } },
      canManage: true,
      passkeys: [LAPTOP, PHONE],
    };
    const fetchMock = stubServer(state);
    const { container } = render(<PasskeySettings />);
    await settle();

    expect(container.querySelector('[data-testid="passkey-session-state"]')?.textContent).toBe("Signed in with the access token");
    expect(button("Sign out")).toBeDefined();
    const items = [...container.querySelectorAll(".set-passkeys__item")];
    expect(items.map((li) => li.querySelector(".set-passkeys__label")?.textContent)).toEqual(["Laptop", "Unnamed passkey"]);
    expect(items[0].textContent).toMatch(/Added .* · last used /);
    expect(items[1].textContent).toContain("never used");
    expect(buttons().filter((b) => b.textContent === "Revoke")).toHaveLength(2);
    expect(button("Add a passkey")).toBeDefined();
    expect(container.textContent).not.toContain("needs a sign-in with the access token");

    // Revoke asks first; declining sends nothing.
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    act(() => buttons().filter((b) => b.textContent === "Revoke")[0].click());
    await settle();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    act(() => buttons().filter((b) => b.textContent === "Revoke")[0].click());
    await settle();
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("“Laptop”"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/passkeys/p1", expect.objectContaining({ method: "DELETE" }));
    expect([...container.querySelectorAll(".set-passkeys__label")].map((el) => el.textContent)).toEqual(["Unnamed passkey"]);

    // Enrol with a label, then the list refreshes.
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred" } as never);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Passkey label"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Desk key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Add a passkey")!.click());
    await settle();
    expect([...container.querySelectorAll(".set-passkeys__label")].map((el) => el.textContent)).toEqual([
      "Unnamed passkey",
      "Desk key",
    ]);
    expect(input.value).toBe("");
  });

  it("signed in with a passkey lists but cannot add or revoke, and says why", async () => {
    stubServer({
      status: { tokenRequired: true, authenticated: true, passkeys: ENABLED, session: { method: "passkey", canManage: false } },
      canManage: false,
      passkeys: [LAPTOP],
    });
    const { container } = render(<PasskeySettings />);
    await settle();

    expect(container.querySelector('[data-testid="passkey-session-state"]')?.textContent).toBe("Signed in with a passkey");
    expect(container.querySelectorAll(".set-passkeys__item")).toHaveLength(1);
    expect(button("Revoke")).toBeUndefined();
    expect(button("Add a passkey")).toBeUndefined();
    expect(container.textContent).toContain("Adding or removing passkeys needs a sign-in with the access token.");
  });

  it("says a cancelled enrolment quietly", async () => {
    stubServer({
      status: { tokenRequired: true, authenticated: true, passkeys: ENABLED, session: { method: "token", canManage: true } },
      canManage: true,
      passkeys: [],
    });
    vi.mocked(startRegistration).mockRejectedValue(Object.assign(new Error("nope"), { name: "NotAllowedError" }));
    const { container } = render(<PasskeySettings />);
    await settle();
    expect(container.textContent).toContain("No passkeys enrolled yet.");
    act(() => button("Add a passkey")!.click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("The passkey prompt was cancelled or timed out.");
  });

  it("signs out and shows the signed-out state", async () => {
    const state: ServerState = {
      status: { tokenRequired: true, authenticated: true, passkeys: ENABLED, session: { method: "passkey", canManage: false } },
      canManage: false,
      passkeys: [LAPTOP],
    };
    stubServer(state);
    const { container } = render(<PasskeySettings />);
    await settle();
    state.status = { ...state.status, authenticated: false };
    act(() => button("Sign out")!.click());
    await settle();
    expect(container.querySelector('[data-testid="passkey-session-state"]')?.textContent).toBe("Not signed in");
    expect(button("Sign in")).toBeDefined();
    expect(container.querySelectorAll(".set-passkeys__item")).toHaveLength(0);
    expect(container.textContent).toContain("Sign in to see the enrolled passkeys.");
  });
});
