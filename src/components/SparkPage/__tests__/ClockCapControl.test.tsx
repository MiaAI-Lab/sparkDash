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

/**
 * Drive a React-controlled <input> the way React's synthetic event system
 * expects: call the NATIVE value setter (React overrides the instance
 * property and tracks it, so a plain `el.value = x` leaves the tracker
 * equal to the new value and React suppresses onChange), then dispatch
 * `input`. Without this, typing into the range/number inputs is a no-op in
 * jsdom and the shared-state assertions below would be vacuous.
 */
function setReactInputValue(el: HTMLInputElement, next: string | number) {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("native input value setter not found");
  setter.call(el, String(next));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** GPU bounds shaped EXACTLY like the server's buildClockCapDomains output:
 *  pure 200 MHz grid, band-limited candidates, named specials on presets. */
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
      stepMHz: 200,
      grid: {
        min: 1000,
        max: 2400,
        step: 200,
        candidates: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400],
        bandApplied: true,
      },
      presets: [
        { label: "Boot default", value: 2418 },
        { label: "No cap", value: null },
      ],
      unitPath: "/etc/systemd/system/gpu-clock-lock.service",
      writable: true,
    },
  ],
};

async function openDialog() {
  const { container } = render(
    <ClockCapControl sparkId="spark-test" domain="gpu" currentMHz={2200} />
  );
  const modify = container.querySelector('button[title="Change the clock cap"]');
  expect(modify?.getAttribute("aria-haspopup")).toBe("dialog");
  await act(async () => {
    modify!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("closed state renders a Modify button + value chip, both dialog-opening (items 4/5)", () => {
    const { container } = render(
      <ClockCapControl sparkId="spark-test" domain="gpu" currentMHz={2200} />
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBe(2);
    const [modify, chip] = buttons;
    expect(modify.textContent).toBe("Modify");
    expect(chip!.textContent).toBe("2200 MHz");
    for (const b of buttons) expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    // Same visual family as the Throttle OK chip in GpuPanel.
    for (const b of buttons) {
      expect(b.className).toMatch(/text-\[10px\]/);
      expect(b.className).toMatch(/font-medium/);
      expect(b.className).toMatch(/uppercase/);
    }
  });

  it("closed state: Modify + chip are ONE right-aligned group so Modify stays put (item 5)", () => {
    const { container } = render(
      <ClockCapControl sparkId="spark-test" domain="gpu" currentMHz={2200} />
    );
    const modify = container.querySelector('button[title="Change the clock cap"]');
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent !== "Modify"
    )!;
    // Both buttons share ONE parent (the flex group), so they move as a unit at
    // the row's right edge — the Modify button no longer floats between the
    // label and the chip, and its x-position is pinned across rows.
    expect(modify!.parentElement).toBe(chip.parentElement);
    // The chip has a fixed width, so its left edge (and therefore Modify's
    // right edge) is constant regardless of the chip text ("2200 MHz" vs
    // "No cap set") — the two CPU cluster rows line up.
    expect(chip.className).toMatch(/w-28/);
  });

  it("renders 'No cap set' when no cap is active (item 4)", () => {
    const { container } = render(
      <ClockCapControl sparkId="spark-test" domain="gpu" currentMHz={null} />
    );
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent !== "Modify"
    )!;
    expect(chip.textContent).toBe("No cap set");
  });

  it("the disabled state has no dialog affordance and reports the reason", () => {
    const { container } = render(
      <ClockCapControl
        sparkId="spark-test"
        domain="gpu"
        currentMHz={2200}
        display="2200 MHz"
        enabled={false}
        disabledReason="Clock control is disabled"
      />
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("2200");
    expect(container.querySelector("span")!.getAttribute("title")).toContain("disabled");
  });

  it("opens on Modify click and loads the hardware bounds for the domain", async () => {
    const { dialog } = await openDialog();
    expect(dialog).not.toBeNull();
    expect(mockGet).toHaveBeenCalledWith("spark-test");
    await flush();
    expect(dialog!.textContent).toContain("0–3003 MHz");
  });

  it("dialog sheet uses the dedicated clock-width class, not the base max-w-md", async () => {
    const { dialog } = await openDialog();
    await flush();
    expect(dialog!.className).toContain("modal-sheet--clock");
    // The base .modal-sheet stays intact for every other dialog in the app.
    expect(dialog!.className).not.toContain("max-w-md");
  });

  it("range input is the pure 200 grid bounded by the band; number input is free entry (item 2)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const range = dialog!.querySelector('input[type="range"]') as HTMLInputElement;
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    // Grid: min/max/step are the server-computed 200-band, NOT the hard bounds.
    expect(range.getAttribute("min")).toBe("1000");
    expect(range.getAttribute("max")).toBe("2400");
    expect(range.getAttribute("step")).toBe("200");
    // Number input keeps the HARD bounds and no step (never snapped).
    expect(number_.getAttribute("min")).toBe("0");
    expect(number_.getAttribute("max")).toBe("3003");
    expect(number_.hasAttribute("step")).toBe(false);
  });

  it("slider and manual entry are SEPARATE labelled elements, not one combined widget (item 2)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const range = dialog!.querySelector('input[type="range"]') as HTMLInputElement;
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    // Each control has its own <label> (not just an aria-label), so they read
    // as two distinct elements.
    const sliderLabel = dialog!.querySelector('label[for="clock-slider-' + range.id.slice("clock-slider-".length) + '"]');
    expect(sliderLabel).not.toBeNull();
    expect(sliderLabel!.textContent).toContain("Slider");
    const entryLabel = dialog!.querySelector('label[for="clock-entry-' + number_.id.slice("clock-entry-".length) + '"]');
    expect(entryLabel).not.toBeNull();
    expect(entryLabel!.textContent).toContain("Manual entry");
    // They are NOT siblings in one flex row — each sits in its own block.
    expect(range.parentElement).not.toBe(number_.parentElement);
  });

  it("moving the range input updates the number input (one value, two controls)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const range = dialog!.querySelector('input[type="range"]') as HTMLInputElement;
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      setReactInputValue(range, "1600");
    });
    await flush();
    expect(number_.value).toBe("1600");
  });

  it("typing an off-grid value stays EXACT and is sent EXACT (number input never snaps) (item 2)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      setReactInputValue(number_, "2000");
    });
    await flush();
    // 2000 is off the 200 grid (the grid lands on 1800/2200): it must remain 2000.
    expect(number_.value).toBe("2000");
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      requestedMHz: 2000,
      appliedMHz: 2000,
      snapped: false,
      persisted: false,
      bootUnit: null,
      source: "container",
      warnings: [],
    });
    const save = Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockSet.mock.calls[0][1]).toEqual({ domain: "gpu", maxMHz: 2000, persist: true });
  });

  it("a value above the hard max is clamped to the hardware ceiling", async () => {
    const { dialog } = await openDialog();
    await flush();
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      setReactInputValue(number_, "9999");
    });
    await flush();
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      requestedMHz: 3003,
      appliedMHz: 3003,
      snapped: false,
      persisted: false,
      bootUnit: null,
      source: "container",
      warnings: [],
    });
    const save = Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockSet.mock.calls[0][1].maxMHz).toBe(3003);
  });

  it("renders exactly the candidate chip row — the 200-grid values inside the band (item 3)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const text = dialog!.textContent ?? "";
    expect(text).toContain("Candidates");
    for (const v of [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400]) {
      const chip = Array.from(dialog!.querySelectorAll("button")).find(
        (b) => b.textContent === `${v} MHz`
      );
      expect(chip, `candidate ${v} present`).toBeTruthy();
    }
    // Off-grid / off-band values must not appear as candidate chips.
    for (const v of [800, 2600, 3000, 1900]) {
      const chip = Array.from(dialog!.querySelectorAll("button")).find(
        (b) => b.textContent === `${v} MHz`
      );
      expect(chip, `${v} absent`).toBeUndefined();
    }
  });

  it("clicking a candidate chip writes the shared value into BOTH controls", async () => {
    const { dialog } = await openDialog();
    await flush();
    const chip = Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent === "1600 MHz")!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const range = dialog!.querySelector('input[type="range"]') as HTMLInputElement;
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    expect(number_.value).toBe("1600");
    expect(range.value).toBe("1600");
  });

  it("keeps the named specials on a separate, visually distinct row from the candidates (item 3)", async () => {
    const { dialog } = await openDialog();
    await flush();
    const labelSpans = Array.from(dialog!.querySelectorAll("span")).filter(
      (s) => s.textContent === "Candidates" || s.textContent === "Presets"
    );
    expect(labelSpans.length).toBe(2);
    const candidateRow = labelSpans.find((s) => s.textContent === "Candidates")!.parentElement!;
    const presetRow = labelSpans.find((s) => s.textContent === "Presets")!.parentElement!;
    expect(candidateRow.isSameNode(presetRow)).toBe(false);
    // Presets are dashed-outline chips; candidates are solid — never confusable.
    expect(presetRow.innerHTML).toContain("border-dashed");
    expect(candidateRow.innerHTML).not.toContain("border-dashed");
    // The named specials live on the presets row, not the candidate row.
    const presetButtons = Array.from(presetRow.querySelectorAll("button")).map((b) => b.textContent);
    expect(presetButtons).toContain("Boot default (2418)");
    expect(presetButtons).toContain("No cap");
    expect(presetButtons).not.toContain("1600 MHz");
    const candidateButtons = Array.from(candidateRow.querySelectorAll("button")).map((b) => b.textContent);
    expect(candidateButtons).toContain("1600 MHz");
    expect(candidateButtons).not.toContain("No cap");
  });

  it("sends persist:true on Save and persist:false on the boot-only button", async () => {
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      requestedMHz: 2200,
      appliedMHz: 2200,
      snapped: false,
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

  it("when the driver snapped the request, the dialog shows BOTH asked and applied (item 6)", async () => {
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      requestedMHz: 2000,
      appliedMHz: 1976,
      snapped: true,
      persisted: false,
      bootUnit: null,
      source: "helper",
      warnings: [],
    });
    const { dialog, container } = await openDialog();
    await flush();
    // Drive the exact number, then apply.
    const number_ = dialog!.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      number_.value = "2000";
      number_.dispatchEvent(new Event("input", { bubbles: true }));
      number_.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const bootOnly = Array.from(dialog!.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Apply")
    )!;
    await act(async () => {
      bootOnly.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const text = dialog!.textContent ?? "";
    expect(text).toContain("asked for 2000");
    expect(text).toContain("applied 1976");
    // And the closed chip only ever shows the APPLIED truth, never the request.
    expect(container.textContent).toContain("1976 MHz");
    expect(container.textContent).not.toContain("2000 MHz");
  });

  it("surfaces the reboot warning from the response warnings", async () => {
    mockSet.mockResolvedValue({
      ok: true,
      domain: "gpu",
      requestedMHz: 2200,
      appliedMHz: 2200,
      snapped: false,
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
