import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSparkDialog } from "./AddSparkDialog";
import { render } from "../testing/render";

vi.mock("../api/client", () => ({
  addSpark: vi.fn(),
  testSparkConfig: vi.fn(),
}));

class MemoryWebSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  send() {}
  close() {}
}

const click = async (label: RegExp) => {
  const button = Array.from(document.querySelectorAll("button")).find((b) => label.test(`${b.textContent ?? ""}|${b.getAttribute("aria-label") ?? ""}`));
  expect(button, String(label)).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const setValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, value);
  act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
};

describe("AddSparkDialog for Raspberry Pi", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MemoryWebSocket);
    Object.defineProperty(window, "location", { configurable: true, value: { protocol: "http:", host: "localhost:5555" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hides local mode, CX7, LLM roles, ports and ComfyUI", async () => {
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);

    const kind = document.getElementById("add-spark-kind") as HTMLSelectElement;
    await act(async () => {
      kind.value = "pi";
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(document.body.textContent).not.toContain("This host (local collectors");
    expect(document.body.textContent).not.toContain("CX7 IP");
    setValue(document.getElementById("add-spark-lan-ip") as HTMLInputElement, "192.168.1.50");
    await click(/^Next: Role/);

    expect(document.body.textContent).toContain("standalone monitors");
    expect(document.body.querySelector(".role-opts")).toBeNull();
    setValue(document.getElementById("add-spark-name") as HTMLInputElement, "luffy-1");
    await click(/^Next: Services/);

    expect(document.body.textContent).not.toContain("LLM ports");
    expect(document.body.textContent).not.toContain("Monitor ComfyUI");
    expect(document.body.textContent).toContain("Monitor Hermes updates");
  });
});
