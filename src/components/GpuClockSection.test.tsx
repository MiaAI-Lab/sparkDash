import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuClock, fetchGpuClockCommand, resetGpuClock, setGpuClock } from "../api/client";
import type { GpuClockStatus } from "../api/types";
import { GpuClockSection } from "./GpuClockSection";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchGpuClock: vi.fn(),
  fetchGpuClockCommand: vi.fn(),
  setGpuClock: vi.fn(),
  resetGpuClock: vi.fn(),
}));

const base: GpuClockStatus = {
  supported: true,
  hwMaxMHz: 3003,
  capMHz: null,
  sudo: "yes",
  persistKind: "unit",
  service: { installed: false, clocks: null, enabled: null, active: null },
  cron: { installed: false, clocks: null },
};

const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];
const byText = (c: HTMLElement, t: string) => buttons(c).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("GpuClockSection", () => {
  beforeEach(() => {
    vi.mocked(fetchGpuClock).mockResolvedValue(base);
    vi.mocked(setGpuClock).mockResolvedValue({
      success: true,
      capMHz: 1800,
      persist: true,
      persistKind: "unit",
    });
    vi.mocked(resetGpuClock).mockResolvedValue({ success: true });
    vi.stubGlobal("confirm", vi.fn(() => true));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the current cap and the boot service state", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...base,
      capMHz: 1800,
      service: { installed: true, clocks: "0,1800", enabled: "enabled", active: "active" },
    });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const now = container.querySelector('[data-testid="gpu-clock-now"]')?.textContent ?? "";
    expect(now).toContain("Capped at 1800 MHz");
    expect(now).toContain("GPU maximum 3003 MHz");
    expect(now).toContain("boot service enabled (0,1800 MHz)");
    const input = container.querySelector("#gpu-clock-max") as HTMLInputElement;
    expect(input.value).toBe("1800");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it("applies a valid cap with the service and refreshes", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const apply = byText(container, "Apply");
    expect(apply.disabled).toBe(true);
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(apply.disabled).toBe(false);
    await act(async () => apply.click());
    await flush();
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: true });
    expect(fetchGpuClock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("kept after reboot");
  });

  it("does not send a cap outside the allowed range", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    for (const bad of ["100", "3500", "1800.5", "abc"]) {
      setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, bad);
      expect(byText(container, "Apply").disabled).toBe(true);
    }
  });

  it("says which hook keeps the cap, and offers the cron one where sudo cannot reach root", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...base,
      persistKind: "cron",
      capMHz: 1800,
      cron: { installed: true, clocks: "0,1800" },
    });
    vi.mocked(setGpuClock).mockResolvedValue({
      success: true,
      capMHz: 1800,
      persist: true,
      persistKind: "cron",
    });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();

    expect(container.querySelector('[data-testid="gpu-clock-now"]')!.textContent).toContain(
      "@reboot job (0,1800 MHz)",
    );
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    expect(container.textContent).toContain("an @reboot cron job");

    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: true });
    expect(container.textContent).toContain("kept after reboot by an @reboot cron job");
  });

  it("offers nothing to keep when the unit has no hook, and says so instead of refusing", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, persistKind: "none" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();

    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(container.textContent).toContain("this unit offers neither");
    expect(container.textContent).toContain("Keep after reboot (not available on this unit)");

    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    await act(async () => byText(container, "Apply").click());
    await flush();
    // The cap still applies — it just will not survive a reboot here.
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: false });
  });

  it("does nothing when the user cancels the service confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => byText(container, "Apply").click());
    expect(setGpuClock).not.toHaveBeenCalled();
  });

  it("without passwordless sudo it asks for the sudo password, sends it once, and clears it", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, sudo: "no" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const pw = container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement;
    expect(pw).not.toBeNull();
    expect(pw.type).toBe("password");
    expect(container.textContent).toContain("never stored or logged");
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    // A valid cap alone is not enough: the password is required.
    expect(byText(container, "Apply").disabled).toBe(true);
    expect(byText(container, "Remove limit").disabled).toBe(true);
    setInput(pw, "s3cret pw");
    expect(byText(container, "Apply").disabled).toBe(false);
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: false, sudoPassword: "s3cret pw" });
    expect((container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement).value).toBe("");
    expect(container.textContent).not.toContain("s3cret pw");

    setInput(container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement, "again");
    await act(async () => byText(container, "Remove limit").click());
    await flush();
    expect(resetGpuClock).toHaveBeenCalledWith("lab", "again");
    expect((container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement).value).toBe("");
  });

  it("a wrong password shows the server's message and is cleared so it is retyped", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, sudo: "no" });
    vi.mocked(setGpuClock).mockRejectedValue(new Error("the sudo password was not accepted"));
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    setInput(container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement, "wrong");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("the sudo password was not accepted");
    expect((container.querySelector("#gpu-clock-sudo-pw") as HTMLInputElement).value).toBe("");
  });

  it("does not offer a password field when the server says it would refuse one from here", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, sudo: "no", passwordAllowed: false });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect(container.querySelector("#gpu-clock-sudo-pw")).toBeNull();
    expect(byText(container, "Apply").disabled).toBe(true);
    expect(container.textContent).toContain("not on https");
  });

  it("with passwordless sudo no password is asked for or sent", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect(container.querySelector("#gpu-clock-sudo-pw")).toBeNull();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: false });
  });

  it("on a page that is not https/localhost no password is typed; the paste-in command is offered instead", async () => {
    vi.stubGlobal("isSecureContext", false);
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, sudo: "no" });
      vi.mocked(fetchGpuClockCommand).mockResolvedValue({ command: "# sparkDash: run this on the Spark itself.\nMAX=1800" });
      const { container } = render(<GpuClockSection sparkId="lab" />);
      await flush();
      expect(container.querySelector("#gpu-clock-sudo-pw")).toBeNull();
      expect(container.textContent).toContain("not on https");
      expect(byText(container, "Apply").disabled).toBe(true);
      expect(byText(container, "Remove limit").disabled).toBe(true);
      expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
      const input = container.querySelector("#gpu-clock-max") as HTMLInputElement;
      expect(input.disabled).toBe(false);
      expect(byText(container, "Show command: apply").disabled).toBe(true);
      setInput(input, "1800");
      await act(async () => byText(container, "Show command: apply").click());
      await flush();
      expect(fetchGpuClockCommand).toHaveBeenCalledWith("lab", { action: "apply", maxMHz: 1800, persist: false });
      const box = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(box.readOnly).toBe(true);
      expect(box.value).toContain("run this on the Spark itself");
    } finally {
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    }
  });

  it("builds the remove command, copies it, and shows an error when it cannot be built", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(fetchGpuClockCommand).mockResolvedValueOnce({ command: "echo remove" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    await act(async () => byText(container, "Show command: remove").click());
    await flush();
    await act(async () => byText(container, "Copy").click());
    await flush();
    expect(fetchGpuClockCommand).toHaveBeenCalledWith("lab", { action: "reset" });
    expect(writeText).toHaveBeenCalledWith("echo remove");
    expect(container.textContent).toContain("Copied");

    vi.mocked(fetchGpuClockCommand).mockRejectedValueOnce(new Error("action must be apply or reset"));
    await act(async () => byText(container, "Show command: remove").click());
    await flush();
    expect(container.textContent).toContain("action must be apply or reset");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("shows a server error from a refused change", async () => {
    vi.mocked(setGpuClock).mockRejectedValue(new Error("nvidia-smi refused the clock cap"));
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("nvidia-smi refused the clock cap");
  });

  it("removes the limit after confirmation", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, capMHz: 2200 });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    await act(async () => byText(container, "Remove limit").click());
    await flush();
    expect(resetGpuClock).toHaveBeenCalledWith("lab", undefined);
  });

  it("explains a unit without nvidia-smi instead of showing controls", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ supported: false, reason: "nvidia-smi was not found on this unit" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect(container.textContent).toContain("nvidia-smi was not found");
    expect(buttons(container)).toHaveLength(0);
  });

  it("ignores a slow answer for the previous unit after switching units", async () => {
    let resolveOld!: (v: GpuClockStatus) => void;
    vi.mocked(fetchGpuClock).mockImplementation((id: string) =>
      id === "old"
        ? new Promise<GpuClockStatus>((r) => (resolveOld = r))
        : Promise.resolve({ ...base, capMHz: 1500, hwMaxMHz: 2418 })
    );
    const { container, root } = render(<GpuClockSection sparkId="old" />);
    await flush();
    act(() => root.render(<GpuClockSection sparkId="new" />));
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("1500");
    await act(async () => resolveOld({ ...base, capMHz: 2200 }));
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("1500");
    expect(container.textContent).toContain("Capped at 1500 MHz");
  });

  it("keeps the form and the success message when the refresh after a change fails", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    vi.mocked(fetchGpuClock).mockRejectedValue(new Error("Could not reach Lab"));
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("Capped at 1800 MHz until the next reboot.");
    expect(container.textContent).toContain("Could not refresh: Could not reach Lab");
    expect(container.querySelector("#gpu-clock-max")).not.toBeNull();
  });

  it("lets you remove a lock that sparkDash did not record", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const remove = byText(container, "Remove limit");
    expect(remove.disabled).toBe(false);
    await act(async () => remove.click());
    await flush();
    expect(resetGpuClock).toHaveBeenCalledWith("lab", undefined);
  });

  it("resets the inputs from the unit after removing the limit", async () => {
    vi.mocked(fetchGpuClock)
      .mockResolvedValueOnce({ ...base, capMHz: 2200, service: { installed: true, clocks: "0,2200", enabled: "enabled", active: "active" } })
      .mockResolvedValue(base);
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("2200");
    await act(async () => byText(container, "Remove limit").click());
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });
});
