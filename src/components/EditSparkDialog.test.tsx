import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuClock, fetchGpuPower, fetchSparks, updateSpark } from "../api/client";
import type { SparkConfig } from "../api/types";
import { EditSparkDialog } from "./EditSparkDialog";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  deleteSpark: vi.fn(),
  fetchSparks: vi.fn(),
  setSparkPassword: vi.fn(),
  testSpark: vi.fn(),
  testSparkConfig: vi.fn(),
  updateSpark: vi.fn(),
  fetchGpuClock: vi.fn(() => Promise.resolve({ supported: false, reason: "test" })),
  setGpuClock: vi.fn(),
  resetGpuClock: vi.fn(),
  fetchGpuPower: vi.fn(() => Promise.resolve({ supported: false, reason: "test" })),
  setGpuPower: vi.fn(),
}));

const spark: SparkConfig = {
  id: "lab",
  name: "Lab",
  lanIp: "192.168.1.50",
  isLocal: false,
  ssh: { host: "192.168.1.50", user: "zurih", auth: "key", port: 2200 },
};

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

describe("EditSparkDialog SSH port", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MemoryWebSocket);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
    vi.mocked(fetchSparks).mockResolvedValue({ sparks: [spark] });
    vi.mocked(updateSpark).mockResolvedValue({ success: true, spark });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("offers the power limit on Linux GPU hosts and the clock cap on Sparks, and neither on Windows", async () => {
    const opened = async (config: Partial<SparkConfig>) => {
      vi.mocked(fetchGpuClock).mockClear();
      vi.mocked(fetchGpuPower).mockClear();
      vi.mocked(fetchSparks).mockResolvedValue({ sparks: [{ ...spark, ...config }] });
      render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
      await flush();
      return [vi.mocked(fetchGpuClock).mock.calls.length > 0, vi.mocked(fetchGpuPower).mock.calls.length > 0];
    };
    expect(await opened({ kind: "host", platform: "linux" })).toEqual([false, true]);
    expect(await opened({ kind: "spark", platform: "linux" })).toEqual([true, false]);
    expect(await opened({ kind: "host", platform: "windows" })).toEqual([false, false]);
    expect(await opened({ kind: "host", platform: "darwin" })).toEqual([false, false]);
  });

  it("shows the saved SSH port and saves a new one", async () => {
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();

    const port = document.getElementById("edit-spark-ssh-port") as HTMLInputElement;
    expect(port).not.toBeNull();
    expect(port.value).toBe("2200");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(port, "2222");
    act(() => port.dispatchEvent(new Event("input", { bubbles: true })));

    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateSpark).toHaveBeenCalledWith(
      "lab",
      expect.objectContaining({
        ssh: expect.objectContaining({ user: "zurih", port: 2222 }),
      })
    );
  });
});
