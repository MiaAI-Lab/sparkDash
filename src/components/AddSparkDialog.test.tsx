import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSparkDialog } from "./AddSparkDialog";
import { render } from "../testing/render";

vi.mock("../api/client", () => ({
  addSpark: vi.fn(),
  testSparkConfig: vi.fn(),
}));

class MemoryWebSocket {
  static instances: MemoryWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    MemoryWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

describe("AddSparkDialog keyboard contract", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MemoryWebSocket);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is a modal dialog that closes on Escape", () => {
    const onClose = vi.fn();
    render(<AddSparkDialog open onClose={onClose} onAdded={() => {}} />);
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).toBe("add-spark-title");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalled();
  });
});
