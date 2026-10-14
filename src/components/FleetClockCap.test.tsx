import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  fetchClockCap: vi.fn(),
  fetchFleetClockAuto: vi.fn(),
  setClockCap: vi.fn(),
  setFleetClockAuto: vi.fn(),
}));

import {
  fetchClockCap,
  fetchFleetClockAuto,
  setClockCap,
  setFleetClockAuto,
} from "../api/client";
import type { SparkSnapshot } from "../api/types";
import { FleetClockCap } from "./FleetClockCap";
import { flush, render } from "../testing/render";

function okStatus(id: string, overrides = {}) {
  return { id, name: id.toUpperCase(), ok: true, mhz: null, stale: false, graphicsClockMHz: null, ...overrides };
}

function autoState(overrides = {}) {
  return {
    enabled: false,
    capMhz: 1800,
    holdTempC: 72,
    releaseTempC: 67,
    range: { min: 1800, max: 2200 },
    presets: [1800, 1900, 2000, 2100, 2200],
    sparks: [],
    ...overrides,
  };
}

function spark(id: string, temp: number | null): SparkSnapshot {
  return {
    id,
    name: id.toUpperCase(),
    online: true,
    metrics: { gpu: temp == null ? null : { temperature: temp } },
  } as unknown as SparkSnapshot;
}

function presetButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".ov-cap__presets > button")].find(
    (b) => b.textContent === label
  );
  if (!btn) throw new Error(`preset button "${label}" not found`);
  return btn;
}

function dialogButton(label: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll<HTMLButtonElement>(".modal-sheet button")].find(
    (b) => b.textContent?.includes(label)
  );
  if (!btn) throw new Error(`dialog button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.mocked(fetchClockCap).mockResolvedValue({ success: true, sparks: [okStatus("a", { mhz: 2000 })] });
  vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState());
  vi.mocked(setClockCap).mockReset();
  vi.mocked(setFleetClockAuto).mockReset();
});

describe("FleetClockCap", () => {
  it("shows per-Spark readouts: live temp, cap, and auto holding state", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b")],
    });
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(
      autoState({
        enabled: true,
        sparks: [
          { id: "a", name: "A", holding: true, lastError: null },
          { id: "b", name: "B", holding: false, lastError: null },
        ],
      })
    );
    const { container } = render(<FleetClockCap sparks={[spark("a", 74), spark("b", 55)]} />);
    await flush();

    const rows = [...container.querySelectorAll(".ov-cap__spark")];
    expect(rows.map((r) => r.querySelector(".ov-cap__name")?.textContent)).toEqual(["A", "B"]);
    expect(rows[0].textContent).toContain("74 °C");
    expect(rows[0].textContent).toContain("2000 MHz");
    expect(rows[0].textContent).toContain("auto hold");
    expect(rows[1].textContent).toContain("55 °C");
    expect(rows[1].textContent).toContain("Unlocked");
  });

  it("targets every Spark from the single fleet control", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1900,
      results: [okStatus("a", { mhz: 1900 }), okStatus("b", { mhz: 1900 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "1900").click();
    });
    await flush();

    const confirm = dialogButton("Set 1900 MHz");
    await act(async () => {
      confirm.click();
    });
    await flush();

    expect(setClockCap).toHaveBeenCalledWith("all", 1900);
  });

  it("toggles fleet auto mode in one action", async () => {
    vi.mocked(setFleetClockAuto).mockResolvedValue(autoState({ enabled: true, capMhz: 2100 }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    const toggle = [...container.querySelectorAll<HTMLButtonElement>(".ov-cap__toggle")][0];
    expect(toggle.textContent).toContain("Auto off");

    await act(async () => {
      toggle.click();
    });
    await flush();

    expect(setFleetClockAuto).toHaveBeenCalledWith(true, undefined);
  });

  it("sends the selected hold cap with auto mode changes", async () => {
    const { container } = render(<FleetClockCap sparks={[spark("a", 60)]} />);
    await flush();

    const select = container.querySelector<HTMLSelectElement>(".ov-cap__capselect select");
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = "2200";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(setFleetClockAuto).toHaveBeenCalledWith(false, 2200);
  });

  it("surfaces a per-node failure instead of failing silently", async () => {
    vi.mocked(setClockCap).mockResolvedValue({
      success: true,
      mhz: 1900,
      results: [
        { id: "a", name: "A", ok: true, mhz: 1900 },
        { id: "b", name: "B", ok: false, error: "ssh: connection refused" },
      ],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    await act(async () => {
      presetButton(container, "1900").click();
    });
    await flush();
    await act(async () => {
      dialogButton("Set 1900 MHz").click();
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Clock cap failed");
    expect(alert?.textContent).toContain("ssh: connection refused");
  });

  // ─── On-load preselect from GET /api/sparks/clock-cap ───

  it("highlights the preset matching the fleet's uniform cap on load", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b", { mhz: 2000 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(presetButton(container, "2000").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(container, "1800").getAttribute("aria-pressed")).toBe("false");
    expect(presetButton(container, "Unlocked").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).not.toContain("Mixed");
  });

  it("highlights Unlocked when every node reports stock clocks", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a"), okStatus("b")],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(presetButton(container, "Unlocked").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton(container, "2000").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows Mixed and highlights nothing when the nodes' caps differ", async () => {
    vi.mocked(fetchClockCap).mockResolvedValue({
      success: true,
      sparks: [okStatus("a", { mhz: 2000 }), okStatus("b", { mhz: 1800 })],
    });
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    expect(container.textContent).toContain("Mixed");
    for (const label of ["1800", "1900", "2000", "2100", "2200", "2300", "2400", "Unlocked"]) {
      expect(presetButton(container, label).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("shows the Auto toggle on when the fleet controller is enabled and the saved hold cap in the dropdown", async () => {
    vi.mocked(fetchFleetClockAuto).mockResolvedValue(autoState({ enabled: true, capMhz: 2100 }));
    const { container } = render(<FleetClockCap sparks={[spark("a", 60), spark("b", 61)]} />);
    await flush();

    const toggle = [...container.querySelectorAll<HTMLButtonElement>(".ov-cap__toggle")][0];
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toContain("Auto on");

    const select = container.querySelector<HTMLSelectElement>(".ov-cap__capselect select");
    expect(select?.value).toBe("2100");
  });
});
