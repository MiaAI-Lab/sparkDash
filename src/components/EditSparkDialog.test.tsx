import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuClock, fetchGpuPower, fetchSparks, updateSpark, installSparkAttic, fetchAtticInstallStatus } from "../api/client";
import type { SparkConfig } from "../api/types";
import { EditSparkDialog } from "./EditSparkDialog";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  deleteSpark: vi.fn(),
  fetchSparks: vi.fn(),
  installSparkAttic: vi.fn(),
  fetchAtticInstallFlags: vi.fn(() => Promise.resolve({ passwordAllowed: true, plainPasswordAllowed: false })),
  fetchAtticInstallStatus: vi.fn(() => Promise.resolve({ installed: true })),
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

  it("opens spark-attic help without changing monitoring", async () => {
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();
    const button = document.querySelector<HTMLButtonElement>('button[aria-controls="attic-monitoring-help"]')!;
    const checkbox = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.includes("spark-attic"))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    expect(document.body.querySelector(".tag--good")?.textContent).toBe("Installed");
    expect(document.getElementById("attic-monitoring-help")).toBeNull();
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("attic-monitoring-help")?.textContent).toContain("status.json");
    expect(checkbox?.checked).toBe(false);
    await act(async () => button.click());
    expect(document.getElementById("attic-monitoring-help")).toBeNull();
  });

  it("does not claim installation when the service status is unknown", async () => {
    vi.mocked(fetchAtticInstallStatus).mockResolvedValueOnce({ installed: null });
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();
    expect(document.body.querySelector(".tag--good")).toBeNull();
  });

  it("enables the install button when checked and installs only after confirmation", async () => {
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(installSparkAttic).mockReset();
    vi.mocked(updateSpark).mockClear();
    vi.mocked(updateSpark).mockResolvedValue({ success: true, spark: { ...spark, atticMonitoring: true } });
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();
    const checkbox = Array.from(document.querySelectorAll("label")).find((label) => label.textContent?.includes("spark-attic"))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const install = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Install or retry spark-attic")!;
    expect(install.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("stop its graphical desktop"));
    expect(updateSpark).not.toHaveBeenCalled();
    expect(installSparkAttic).not.toHaveBeenCalled();
    confirmation.mockReturnValue(true);
    vi.mocked(installSparkAttic).mockResolvedValue({ success: true });
    await act(async () => install.click());
    expect(updateSpark).toHaveBeenCalledWith("lab", { atticMonitoring: true });
    expect(installSparkAttic).toHaveBeenCalledWith("lab", undefined);
    const result = Array.from(document.querySelectorAll('[role="status"]')).find((el) => el.textContent?.includes("spark-attic is installed and running"));
    expect(result?.className).toContain("modal-sheet__success");
    confirmation.mockRestore();
  });

  it("offers a confirmed retry for an already monitored Spark and shows failure", async () => {
    vi.mocked(fetchSparks).mockResolvedValue({ sparks: [{ ...spark, atticMonitoring: true }] });
    vi.mocked(installSparkAttic).mockRejectedValueOnce(new Error("sudo refused"));
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();
    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Install or retry spark-attic")!;
    await act(async () => retry.click());
    expect(installSparkAttic).toHaveBeenCalledWith("lab", undefined);
    const result = document.querySelector('[role="alert"]');
    expect(result?.textContent).toContain("sudo refused");
    expect(result?.className).toContain("modal-sheet__error");
    confirmation.mockRestore();
  });

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

  it("sends the edited LAN IP as the SSH host when the host followed the old IP", async () => {
    render(<EditSparkDialog open sparkId="lab" onClose={() => {}} onSaved={() => {}} />);
    await flush();

    const lan = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find((input) => input.value === "192.168.1.50");
    expect(lan).toBeDefined();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(lan, "192.168.1.60");
    act(() => lan?.dispatchEvent(new Event("input", { bubbles: true })));

    const save = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Save");
    await act(async () => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateSpark).toHaveBeenCalledWith(
      "lab",
      expect.objectContaining({ lanIp: "192.168.1.60", ssh: expect.objectContaining({ host: "192.168.1.60" }) })
    );
  });
});
