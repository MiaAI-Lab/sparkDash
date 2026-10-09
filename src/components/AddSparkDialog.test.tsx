import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSpark } from "../api/client";
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

  it("walks Connect, Role and Services and sends the SSH port with a new spark", async () => {
    vi.mocked(addSpark).mockResolvedValue({ success: true, spark: {} as never });
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);

    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, value);
      act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
    };
    const click = async (label: RegExp | string) => {
      const button = Array.from(document.querySelectorAll("button")).find((b) => {
        const text = `${b.textContent ?? ""}|${b.getAttribute("aria-label") ?? ""}`;
        return typeof label === "string" ? text.split("|").includes(label) : label.test(text);
      });
      expect(button, String(label)).toBeDefined();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    // Step 1: Connect
    const lanIp = document.getElementById("add-spark-lan-ip") as HTMLInputElement;
    const port = document.getElementById("add-spark-ssh-port") as HTMLInputElement;
    expect(port).not.toBeNull();
    expect(port.value).toBe("22");
    const next1 = Array.from(document.querySelectorAll("button")).find((b) => /^Next: Role/.test(b.textContent ?? ""));
    expect(next1?.disabled).toBe(true);
    setValue(lanIp, "192.168.1.50");
    setValue(port, "2222");
    await click(/^Next: Role/);

    // Step 2: Role (name is required)
    const next2 = Array.from(document.querySelectorAll("button")).find((b) => /^Next: Services/.test(b.textContent ?? ""));
    expect(next2?.disabled).toBe(true);
    await click(/^Head/);
    setValue(document.getElementById("add-spark-name") as HTMLInputElement, "Lab Spark");
    await click(/^Next: Services/);

    // Step 3: Services
    await click("Monitor Hermes updates");
    await click("Add Spark");

    expect(addSpark).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "lab-spark",
        name: "Lab Spark",
        lanIp: "192.168.1.50",
        role: "head",
        hermesMonitoring: true,
        ssh: expect.objectContaining({ user: "zurih", port: 2222 }),
      })
    );
  });

  it("labels the final button after the chosen unit type", async () => {
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
    const setKind = (value: string) => {
      const select = document.getElementById("add-spark-kind") as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, value);
      act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    };
    const setValue = (el: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, value);
      act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
    };
    const click = async (label: RegExp) => {
      const button = Array.from(document.querySelectorAll("button")).find((b) => label.test(b.textContent ?? ""));
      expect(button, String(label)).toBeDefined();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    const buttons = () => Array.from(document.querySelectorAll("button")).map((b) => b.textContent);

    setKind("host");
    setValue(document.getElementById("add-spark-lan-ip") as HTMLInputElement, "192.168.1.60");
    await click(/^Next: Role/);
    setValue(document.getElementById("add-spark-name") as HTMLInputElement, "Workstation");
    await click(/^Next: Services/);
    expect(buttons()).toContain("Add GPU Host");
    expect(buttons()).not.toContain("Add Spark");

    await click(/^Back/);
    await click(/^Back/);
    setKind("spark");
    await click(/^Next: Role/);
    await click(/^Next: Services/);
    expect(buttons()).toContain("Add Spark");
  });
});
