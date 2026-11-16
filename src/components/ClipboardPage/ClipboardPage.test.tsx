import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { ClipboardPage } from "./ClipboardPage";
import { _resetClipboardRevision, publishClipboardRevision } from "../../hooks/clipboardRevision";
import type { ClipboardEntry } from "../../api/clipboardClient";
import { checkFilesLimit, checkTextLimit, entryTypeFor } from "./clipboardFormat";

const limits = { maxEntries: 10, maxTextBytes: 16, maxPartBytes: 100, maxParts: 2, maxEntryBytes: 150 };

function textEntry(id: string, text: string, createdAt = Date.now() - 5 * 60_000): ClipboardEntry {
  return {
    id, type: "text", textSize: text.length, textPreview: text, textTruncated: false, parts: [], size: text.length,
    contentKey: `k-${id}`, source: { kind: "browser", device: null }, createdAt,
  };
}

const filesEntry: ClipboardEntry = {
  id: "e-files", type: "files", textSize: 0, textPreview: null, textTruncated: false,
  parts: [{ id: "p1", name: "notes.pdf", mimeType: "application/pdf", size: 2048, sha256: "x" }],
  size: 2048, contentKey: "k-files", source: { kind: "device", device: "workstation" }, createdAt: Date.now() - 3 * 3_600_000,
};

let revision = 1;
let history: ClipboardEntry[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function calls(method: string, path: string) {
  return fetchMock.mock.calls.filter(([url, init]) => url === path && ((init as RequestInit | undefined)?.method ?? "GET") === method);
}

beforeEach(() => {
  _resetClipboardRevision();
  revision = 1;
  history = [textEntry("e-text", "hello\n  world"), filesEntry];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/clipboard" && method === "GET") return json({ revision, latest: history[0] ?? null, limits });
    if (url === "/api/clipboard/history") return json({ revision, entries: history });
    if (url === "/api/clipboard/text" && method === "POST") {
      const entry = textEntry("e-new", String(init?.body));
      history = [entry, ...history];
      revision += 1;
      return json({ entry, revision }, 201);
    }
    if (url.startsWith("/api/clipboard/") && method === "DELETE") {
      history = history.filter((e) => `/api/clipboard/${e.id}` !== url);
      revision += 1;
      return json({ removed: true, revision });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("checks limits on the client before sending", () => {
  expect(checkTextLimit("a".repeat(16), limits)).toBeNull();
  expect(checkTextLimit("é".repeat(9), limits)).toEqual({ kind: "textTooLarge", limit: 16 });
  const file = (name: string, size: number, type = "") => new File([new Uint8Array(size)], name, { type });
  expect(checkFilesLimit([file("a", 1), file("b", 1), file("c", 1)], limits)?.kind).toBe("tooManyParts");
  expect(checkFilesLimit([file("big", 101)], limits)).toEqual({ kind: "partTooLarge", name: "big", limit: 100 });
  expect(checkFilesLimit([file("a", 80), file("b", 80)], limits)?.kind).toBe("entryTooLarge");
  expect(entryTypeFor([file("shot.png", 1, "image/png")])).toBe("image");
  expect(entryTypeFor([file("shot.png", 1, "image/png"), file("b", 1)])).toBe("files");
});

it("renders the latest entry and the history from the server", async () => {
  const { container } = render(<ClipboardPage />);
  await flush();
  expect(container.querySelector(".cb-text")?.textContent).toBe("hello\n  world");
  const rows = container.querySelectorAll(".cb-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Browser");
  expect(rows[0].textContent).toContain("5 min ago");
  expect(rows[1].textContent).toContain("notes.pdf");
  expect(rows[1].textContent).toContain("workstation");
  expect(rows[1].textContent).toContain("2 KB");
});

it("shows the server's refusal text", async () => {
  fetchMock.mockImplementation(async () => json({ error: "Set SPARKDASH_TOKEN to use the clipboard remotely" }, 403));
  const { container } = render(<ClipboardPage />);
  await flush();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Set SPARKDASH_TOKEN to use the clipboard remotely");
});

it("shares typed text as a plain-text post", async () => {
  const { container } = render(<ClipboardPage />);
  await flush();
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "from test");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    (container.querySelector("form button[type=submit]") as HTMLButtonElement).click();
  });
  await flush();
  const posts = calls("POST", "/api/clipboard/text");
  expect(posts).toHaveLength(1);
  const init = posts[0][1] as RequestInit;
  expect(init.body).toBe("from test");
  expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain;charset=utf-8");
  expect(container.querySelector(".cb-text")?.textContent).toBe("from test");
  expect(textarea.value).toBe("");
});

it("refuses text over the limit without posting", async () => {
  const { container } = render(<ClipboardPage />);
  await flush();
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "x".repeat(17));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    (container.querySelector("form button[type=submit]") as HTMLButtonElement).click();
  });
  expect(calls("POST", "/api/clipboard/text")).toHaveLength(0);
  expect(container.querySelector("[role=alert]")?.textContent).toContain("larger than the 16 B limit");
});

it("deletes one entry", async () => {
  const { container } = render(<ClipboardPage />);
  await flush();
  const row = container.querySelectorAll(".cb-row")[1];
  await act(async () => {
    (row.querySelector("button[aria-label^='Delete']") as HTMLButtonElement).click();
  });
  await flush();
  expect(calls("DELETE", "/api/clipboard/e-files")).toHaveLength(1);
  expect(container.querySelectorAll(".cb-row")).toHaveLength(1);
});

it("refetches when the WebSocket announces a new revision", async () => {
  const { container } = render(<ClipboardPage />);
  await flush();
  expect(calls("GET", "/api/clipboard/history")).toHaveLength(1);
  act(() => publishClipboardRevision(1));
  await flush();
  expect(calls("GET", "/api/clipboard/history")).toHaveLength(1);
  history = [textEntry("e-remote", "from another device"), ...history];
  revision = 2;
  act(() => publishClipboardRevision(2));
  await flush();
  expect(calls("GET", "/api/clipboard/history")).toHaveLength(2);
  expect(container.querySelector(".cb-text")?.textContent).toBe("from another device");
});
