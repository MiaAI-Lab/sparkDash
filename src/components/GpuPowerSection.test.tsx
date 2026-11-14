import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuPower, setGpuPower } from "../api/client";
import type { GpuPowerCard, GpuPowerStatus } from "../api/types";
import { GpuPowerSection } from "./GpuPowerSection";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchGpuPower: vi.fn(),
  setGpuPower: vi.fn(),
}));

const card = (over: Partial<GpuPowerCard> = {}): GpuPowerCard => ({
  index: 0,
  uuid: "GPU-aaaaaaaa",
  name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
  limitW: 300,
  enforcedW: 300,
  defaultW: 600,
  minW: 150,
  maxW: 600,
  adjustable: true,
  bootW: null,
  ...over,
});

const base: GpuPowerStatus = {
  supported: true,
  cards: [card(), card({ index: 1, uuid: "GPU-bbbbbbbb" })],
  sudo: "yes",
  service: { installed: false, enabled: null, active: null },
  otherServices: [],
};

const byText = (c: HTMLElement, t: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
const input = (c: HTMLElement, uuid: string) => c.querySelector(`[id="gpu-power-${uuid}"]`) as HTMLInputElement;
const checkbox = (c: HTMLElement) => c.querySelector('input[type="checkbox"]') as HTMLInputElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("GpuPowerSection", () => {
  beforeEach(() => {
    vi.mocked(fetchGpuPower).mockResolvedValue(base);
    vi.mocked(setGpuPower).mockResolvedValue({ success: true, limits: [], persist: false });
    vi.stubGlobal("confirm", vi.fn(() => true));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows every card with its limit, range and default, and nothing to apply yet", async () => {
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(input(container, "GPU-aaaaaaaa").value).toBe("300");
    expect(input(container, "GPU-bbbbbbbb").value).toBe("300");
    expect(container.textContent).toContain("GPU 0");
    expect(container.textContent).toContain("RTX PRO 6000 Blackwell");
    expect(container.textContent).toContain("150–600, default 600 W");
    expect(byText(container, "Apply").disabled).toBe(true);
    expect(container.querySelector("#gpu-power-sudo-pw")).toBeNull();
  });

  it("sends only the card that changed, then reloads", async () => {
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    setInput(input(container, "GPU-bbbbbbbb"), "275");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenCalledWith("rtx", { limits: [{ uuid: "GPU-bbbbbbbb", watts: 275 }], persist: false });
    expect(fetchGpuPower).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("GPU 1 275 W, until the next reboot.");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses a value outside the card's range, a fraction and an empty box", async () => {
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    for (const bad of ["149", "601", "250.5", ""]) {
      setInput(input(container, "GPU-aaaaaaaa"), bad);
      expect(byText(container, "Apply").disabled).toBe(true);
    }
    setInput(input(container, "GPU-aaaaaaaa"), "700");
    expect(container.textContent).toContain("Enter a whole number from 150 to 600.");
    setInput(input(container, "GPU-aaaaaaaa"), "600");
    expect(byText(container, "Apply").disabled).toBe(false);
  });

  it("a card without a readable range is shown as unknown, not as 0 W, and is never sent", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({
      ...base,
      cards: [card(), card({ index: 1, uuid: "GPU-cccccccc", limitW: null, enforcedW: null, defaultW: null, minW: null, maxW: null, adjustable: false })],
    });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(input(container, "GPU-cccccccc")).toBeNull();
    expect(container.textContent).toContain("now —");
    expect(container.textContent).toContain("cannot be set here");
    expect(container.textContent).not.toContain("0 W ·");
    setInput(input(container, "GPU-aaaaaaaa"), "250");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenCalledWith("rtx", { limits: [{ uuid: "GPU-aaaaaaaa", watts: 250 }], persist: false });
  });

  it("asks before installing the boot service, and sends nothing if declined", async () => {
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    act(() => checkbox(container).click());
    expect(byText(container, "Apply").disabled).toBe(false);
    vi.mocked(confirm).mockReturnValue(false);
    await act(async () => byText(container, "Apply").click());
    expect(setGpuPower).not.toHaveBeenCalled();
    vi.mocked(confirm).mockReturnValue(true);
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenCalledWith("rtx", { limits: [], persist: true });
  });

  it("with the service installed: ticked by default, no second confirm, and unticking removes it", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({
      ...base,
      cards: [card({ bootW: 300 }), card({ index: 1, uuid: "GPU-bbbbbbbb", bootW: 300 })],
      service: { installed: true, enabled: "enabled", active: "active" },
    });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(checkbox(container).checked).toBe(true);
    expect(byText(container, "Apply").disabled).toBe(true);
    setInput(input(container, "GPU-aaaaaaaa"), "250");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(setGpuPower).toHaveBeenLastCalledWith("rtx", { limits: [{ uuid: "GPU-aaaaaaaa", watts: 250 }], persist: true });
    act(() => checkbox(container).click());
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenLastCalledWith("rtx", { limits: [], persist: false });
    expect(container.textContent).toContain("Boot service removed.");
  });

  it("a boot service that sets something else can be brought back in line, and a failed one is called out", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({
      ...base,
      cards: [card({ bootW: 280 }), card({ index: 1, uuid: "GPU-bbbbbbbb", bootW: 300 })],
      service: { installed: true, enabled: "enabled", active: "failed" },
    });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(container.textContent).toContain("boot service sets 280 W");
    expect(container.textContent).toContain("boot service failed");
    expect(byText(container, "Apply").disabled).toBe(false);
  });

  it("warns about another boot unit, with what it means for the box as ticked", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({ ...base, otherServices: ["nvidia-power-limit.service"] });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(container.textContent).toContain("nvidia-power-limit.service also sets a power limit at boot.");
    expect(container.textContent).toContain("go back to its value at the next reboot");
    act(() => checkbox(container).click());
    expect(container.textContent).toContain("runs after it, so these limits are the ones that stay");
  });

  it("Fill in defaults only fills the boxes: nothing is sent until Apply", async () => {
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    act(() => byText(container, "Fill in defaults").click());
    expect(input(container, "GPU-aaaaaaaa").value).toBe("600");
    expect(input(container, "GPU-bbbbbbbb").value).toBe("600");
    expect(setGpuPower).not.toHaveBeenCalled();
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenCalledWith("rtx", {
      limits: [{ uuid: "GPU-aaaaaaaa", watts: 600 }, { uuid: "GPU-bbbbbbbb", watts: 600 }],
      persist: false,
    });
  });

  it("asks for the sudo password when there is no passwordless sudo, sends it once and clears it", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({ ...base, sudo: "no" });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    const pw = container.querySelector("#gpu-power-sudo-pw") as HTMLInputElement;
    expect(pw.type).toBe("password");
    expect(container.textContent).toContain("never stored or logged");
    setInput(input(container, "GPU-aaaaaaaa"), "250");
    expect(byText(container, "Apply").disabled).toBe(true);
    setInput(pw, "s3cret pw");
    expect(byText(container, "Apply").disabled).toBe(false);
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(setGpuPower).toHaveBeenCalledWith("rtx", { limits: [{ uuid: "GPU-aaaaaaaa", watts: 250 }], persist: false, sudoPassword: "s3cret pw" });
    expect((container.querySelector("#gpu-power-sudo-pw") as HTMLInputElement).value).toBe("");
    expect(container.textContent).not.toContain("s3cret pw");
  });

  it("a wrong password shows the server's message and has to be retyped", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({ ...base, sudo: "no" });
    vi.mocked(setGpuPower).mockRejectedValue(new Error("the sudo password was not accepted"));
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    setInput(input(container, "GPU-aaaaaaaa"), "250");
    setInput(container.querySelector("#gpu-power-sudo-pw") as HTMLInputElement, "nope");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("the sudo password was not accepted");
    expect((container.querySelector("#gpu-power-sudo-pw") as HTMLInputElement).value).toBe("");
  });

  it("on plain http without the setting: no password box, Apply is off, and it offers a command for the host", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({ ...base, sudo: "no", passwordAllowed: false, plainPasswordAllowed: false });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(container.querySelector("#gpu-power-sudo-pw")).toBeNull();
    expect(container.textContent).toContain("Allow sudo password over plain http");
    setInput(input(container, "GPU-aaaaaaaa"), "250");
    expect(byText(container, "Apply").disabled).toBe(true);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("sudo nvidia-smi -i GPU-aaaaaaaa -pl 250");
  });

  it("on plain http with the setting on: the password box is offered", async () => {
    vi.stubGlobal("isSecureContext", false);
    vi.mocked(fetchGpuPower).mockResolvedValue({ ...base, sudo: "no", passwordAllowed: true, plainPasswordAllowed: true });
    const { container } = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(container.querySelector("#gpu-power-sudo-pw")).not.toBeNull();
  });

  it("a host with no NVIDIA card says why, and a failed read shows the error", async () => {
    vi.mocked(fetchGpuPower).mockResolvedValue({ supported: false, reason: "nvidia-smi was not found on this unit" });
    const first = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(first.container.textContent).toContain("nvidia-smi was not found on this unit");
    expect(first.container.querySelector("input")).toBeNull();

    vi.mocked(fetchGpuPower).mockRejectedValue(new Error("Could not reach RTX 6k"));
    const second = render(<GpuPowerSection sparkId="rtx" />);
    await flush();
    expect(second.container.textContent).toContain("Could not reach RTX 6k");
  });
});
