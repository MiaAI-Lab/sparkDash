import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessTokenPrompt } from "./AccessTokenDialog";
import { fetchSparks } from "../api/client";
import { getToken, requestTokenPrompt } from "../api/authToken";
import { flush, render } from "../testing/render";

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
