import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { ChatPage } from "./ChatPage";

beforeEach(async () => {
  await setLocale("en");
});
afterEach(async () => {
  await setLocale("en");
  vi.unstubAllGlobals();
});

describe("Chat page localization", () => {
  it("relocalizes copy and keeps typed text across an English / Simplified Chinese round-trip", async () => {
    const { container } = render(<ChatPage />);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.chat-input")!;
    expect(container.textContent).toContain("One message at a time to the local model on this Spark");
    expect(textarea.getAttribute("placeholder")).toContain("Enter to send");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Visible typed text");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("Visible typed text");
    await act(() => setLocale("zh-CN"));
    expect(container.querySelector("h1")?.textContent).toBe("聊天");
    expect(container.textContent).toContain("用于确认模型可以正常回复");
    expect(textarea.getAttribute("placeholder")).toContain("Shift+Enter 换行");
    expect(container.querySelector("button")?.textContent).toBe("发送");
    expect(textarea.value).toBe("Visible typed text");
    await act(() => setLocale("en"));
    expect(container.querySelector("h1")?.textContent).toBe("Chat");
    expect(container.querySelector("button")?.textContent).toBe("Send");
    expect(textarea.value).toBe("Visible typed text");
  });

  it("posts the typed message and shows the streamed reply plus stats", async () => {
    const chunks = [
      `data: ${JSON.stringify({ model: "discovered-model", choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { completion_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      body: {
        getReader() {
          let i = 0;
          return {
            read: async () => (i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true, value: undefined }),
          };
        },
      },
    })));
    const { container } = render(<ChatPage />);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.chat-input")!;
    await act(async () => {
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Ping");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith("/api/chat", expect.objectContaining({ method: "POST" }));
    expect(container.textContent).toContain("You: Ping");
    expect(container.textContent).toContain("Hello");
    expect(container.querySelector("[data-testid=chat-stats]")?.textContent).toContain("discovered-model");
  });
});
