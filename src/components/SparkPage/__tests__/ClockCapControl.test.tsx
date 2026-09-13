import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClockCapControl } from "../ClockCapControl";
import { render, flush } from "../../../testing/render";
import { getClockCapBounds, setClockCap } from "../../../api/client";
import type { ClockCapBoundsResponse } from "../../../api/types";

vi.mock("../../../api/client", () => ({
  getClockCapBounds: vi.fn(),
  setClockCap: vi.fn(),
}));

const mockGet = vi.mocked(getClockCapBounds);
const mockSet = vi.mocked(setClockCap);

const GPU_BOUNDS: ClockCapBoundsResponse = {
  ok: true,
  sparkId: "spark-test",
  helper: { available: true, checked: true },
  domains: [
    {
      id: "gpu",
      label: "GPU",
      currentMHz: 2200,
      hardMinMHz: 0,
      hardMaxMHz: 3003,
      stepMHz: 25,
      presets: [{ label: "No cap", value: null }],
      unitPath: "/etc/systemd/system/gpu-clock-lock.service",
      writable: true,
    },
  ],
};

async function openDialog() {
  const { container } = render(
    <ClockCapControl sparkId="spark-test" domain="gpu" currentMHz={2200} display="2200 MHz" />
  );
  const button = container.querySelector("button");
  expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
  return { container, dialog: document.querySelector('[role="dialog"][aria-modal="true"]') };
}

describe("ClockCapControl", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    mockGet.mockResolvedValue(GPU_BOUNDS);
  });

  it("renders the cap as a dialog-opening button (closed state = plain text when disabled)", () => {
    const { container } = render(
      <ClockCapControl
        sparkId="spark-test"
        domain="gpu"
        currentMHz={2200}
        display="2200"
        enabled={false}
        disabledReason="Clock control is disabled"
      />
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("2200");
  });

  it("opens on click and loads the hardware bounds for the domain", async () => {
    const { dialog } = await openDialog();
    expect(dialog).not.toBeNull();
    expect(mockGet).toHaveBeenCalledWith("spark-test");
    await flush();
    expect(dialog!.textContent).toContain("0–3003 MHz");
  });

  it("sends persist:true on Save and persist:false on the boot-only button", async () => {
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      appliedMHz: 2500,
      persisted: true,
      bootUnit: "/etc/systemd/system/gpu-clock-lock.service",
      source: "helper",
      warnings: [],
    });
    const { dialog } = await openDialog();
    await flush();
    const buttons = Array.from(dialog!.querySelectorAll("button"));
    const save = buttons.find((b) => b.textContent === "Save");
    const bootOnly = buttons.find((b) => b.textContent?.startsWith("Apply"));
    expect(save).toBeTruthy();
    expect(bootOnly).toBeTruthy();

    mockSet.mockClear();
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.calls[0][0]).toBe("spark-test");
    expect(mockSet.mock.calls[0][1]).toEqual({ domain: "gpu", maxMHz: 2200, persist: true });

    mockSet.mockClear();
    await act(async () => {
      bootOnly!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockSet.mock.calls[0][1]).toEqual({ domain: "gpu", maxMHz: 2200, persist: false });
  });

  it("clamps user input to the domain bounds", async () => {
    const { dialog } = await openDialog();
    await flush();
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    expect(number_).not.toBeNull();
    await act(async () => {
      number_.value = "9999";
      number_.dispatchEvent(new Event("input", { bubbles: true }));
      number_.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    // React reads e.target.value on change; our onChange clamps via state.
    // The applied request must never exceed the hard max.
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      appliedMHz: 3003,
      persisted: false,
      bootUnit: null,
      source: "container",
      warnings: [],
    });
    const save = Array.from(dialog!.querySelectorAll("button")).find(
      (b) => b.textContent === "Save"
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const body = mockSet.mock.calls[0][1];
    expect(body.maxMHz).toBeLessThanOrEqual(3003);
    expect(body.maxMHz).toBeGreaterThanOrEqual(0);
  });

  it("surfaces the reboot warning from the response warnings", async () => {
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      appliedMHz: 2200,
      persisted: false,
      bootUnit: null,
      source: "container",
      warnings: ["applied this boot only — reverts on reboot"],
    });
    const { dialog } = await openDialog();
    await flush();
    const bootOnly = Array.from(dialog!.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Apply")
    )!;
    await act(async () => {
      bootOnly.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(dialog!.textContent).toContain("reverts on reboot");
    expect(dialog!.textContent).toContain("this boot only");
  });

  it("shows a load error when the bounds request fails (e.g. helper missing)", async () => {
    mockGet.mockRejectedValueOnce(new Error("clock helper not installed — run scripts/install-clock-helper.sh on the host"));
    const { dialog } = await openDialog();
    await flush();
    expect(dialog!.textContent).toContain("install-clock-helper.sh");
  });
});
